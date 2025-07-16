// app.js
const express       = require('express');
const http          = require('http');
const socketIo      = require('socket.io');
const fileUpload    = require('express-fileupload');
const { parse: csvParse } = require('csv-parse');
const fs            = require('fs-extra');
const path          = require('path');
const axios         = require('axios');
const morgan        = require('morgan');
const { promisify } = require('util');

const app       = express();
const server    = http.createServer(app);
const io        = socketIo(server);

app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(fileUpload({ limits: { fileSize: 50 * 1024 * 1024 } }));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const STATE_FILE = path.join(__dirname, 'state.json');
fs.ensureDirSync(UPLOAD_DIR);

let isRunning  = false;
let shouldStop = false;

async function saveState(idx) {
  await fs.writeJson(STATE_FILE, { lastProcessed: idx });
}

async function loadState() {
  const ok = await fs.pathExists(STATE_FILE);
  if (!ok) return { lastProcessed: 0 };
  return fs.readJson(STATE_FILE);
}

function safeStr(value, def = '') {
  if (value == null) return def;
  return String(value).trim();
}

// Serve upload form
app.get('/', (req, res) => {
  res.render('index', { error: null, filename: null });
});

// Handle CSV upload, then client triggers processing via Socket.IO
app.post('/process', async (req, res) => {
  try {
    const { access_token, store_domain } = req.body;
    if (!req.files?.csv || !access_token || !store_domain) {
      return res.render('index', { error: 'All fields are required.', filename: null });
    }
    const csvFile = req.files.csv;
    const filename = csvFile.name;
    await csvFile.mv(path.join(UPLOAD_DIR, filename));
    // Pass filename back to client to start via Socket.IO
    return res.render('index', { error: null, filename });
  } catch (e) {
    return res.render('index', { error: e.message, filename: null });
  }
});

// Socket.IO control
io.on('connection', socket => {
  socket.on('start', async ({ filename, access_token, store_domain }) => {
    if (isRunning) return;
    isRunning = true;
    shouldStop = false;

    const { lastProcessed } = await loadState();
    socket.emit('log', `Resuming from row ${lastProcessed + 1}`);
    runProcessing(socket, filename, access_token, store_domain, lastProcessed);
  });

  socket.on('stop', () => {
    if (isRunning) {
      shouldStop = true;
      socket.emit('log', 'Stop requested. Halting after current row.');
    }
  });
});

async function runProcessing(socket, filename, token, domain, startIdx = 0) {
  try {
    const csvPath = path.join(UPLOAD_DIR, filename);
    const content = await fs.readFile(csvPath, 'utf8');
    const records = await promisify(csvParse)(content, {
      columns: true, skip_empty_lines: true, trim: true
    });

    const apiBase = `https://${domain.replace(/^https?:\/\//,'')}/admin/openapi/v20251201`;
    const client  = axios.create({
      baseURL: apiBase,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      timeout: 30000
    });

    for (let i = startIdx; i < records.length; i++) {
      if (shouldStop) break;
      const row = records[i];
      socket.emit('log', `Processing row ${i+1}/${records.length}...`);

      // Build payload (customer, addresses, line_items, etc.)
      const customer = {
        email: safeStr(row.customer_email),
        first_name: safeStr(row.customer_first_name),
        last_name: safeStr(row.customer_last_name),
        area_code: safeStr(row.customer_area_code, '+1'),
        phone: safeStr(row.customer_phone, '')
      };
      const ship = {
        address1: safeStr(row.shipping_address1),
        address2: safeStr(row.shipping_address2),
        city: safeStr(row.shipping_city),
        province: safeStr(row.shipping_state),
        country: safeStr(row.shipping_country, 'United States'),
        country_code: safeStr(row.shipping_country_code, 'US'),
        zip: safeStr(row.shipping_zip),
        first_name: customer.first_name,
        last_name: customer.last_name,
        email: customer.email,
        phone: customer.phone,
        company: safeStr(row.shipping_company, '')
      };
      let billing = { ...ship, same_as_receiver: true };
      if (['yes','true','1'].includes(safeStr(row.billing_different).toLowerCase())) {
        billing = {
          address1: safeStr(row.billing_address1, ship.address1),
          address2: safeStr(row.billing_address2, ship.address2),
          city: safeStr(row.billing_city, ship.city),
          province: safeStr(row.billing_state, ship.province),
          country: safeStr(row.billing_country, ship.country),
          country_code: safeStr(row.billing_country_code, ship.country_code),
          zip: safeStr(row.billing_zip, ship.zip),
          first_name: customer.first_name,
          last_name: customer.last_name,
          email: customer.email,
          phone: customer.phone,
          company: safeStr(row.billing_company, ship.company)
        };
      }
      const line_items = [];
      for (let j = 1; j <= 5; j++) {
        const title = safeStr(row[`product_${j}_name`]);
        const price = parseFloat(safeStr(row[`product_${j}_price`], '0'));
        const qty   = parseInt(safeStr(row[`product_${j}_quantity`], '1'), 10);
        if (title && price) {
          line_items.push({
            title,
            price: price.toFixed(2),
            quantity: qty,
            requires_shipping: true,
            taxable: true,
            sku: safeStr(row[`product_${j}_sku`], undefined)
          });
        }
      }
      if (!line_items.length) {
        socket.emit('log', `❌ Row ${i+1}: no products`);
        await saveState(i);
        continue;
      }
      // Payment status
      const pm = safeStr(row.payment_method, 'COD').toUpperCase();
      let financial_status = 'unpaid';
      if (['PAID','ONLINE','CREDIT_CARD','PAYPAL'].includes(pm)) financial_status='paid';
      else if (['PENDING','PROCESSING'].includes(pm)) financial_status='pending';
      else if (['AUTHORIZED','AUTH'].includes(pm)) financial_status='authorized';
      const ship_price = parseFloat(safeStr(row.shipping_price,'0'));
      const note       = safeStr(row.order_note);
      const currency   = safeStr(row.currency,'USD');

      const orderData = {
        order: {
          customer,
          shipping_address: ship,
          billing_address: billing,
          line_items,
          currency,
          financial_status,
          fulfillment_status: 'unshipped',
          send_receipt: true,
          send_fulfillment_receipt: false,
          price_info: {
            total_shipping_price: ship_price.toFixed(2),
            taxes_included: false,
            current_extra_total_discounts: '0.00'
          },
          ...(note && { order_note: note }),
          ...(ship_price > 0 && {
            shipping_line: {
              title: 'Standard Shipping',
              price: ship_price.toFixed(2),
              code: 'STANDARD'
            }
          })
        }
      };

      try {
        await client.post('/orders.json', orderData);
        socket.emit('log', `✔ Row ${i+1} OK`);
      } catch (e) {
        socket.emit('log', `❌ Row ${i+1} failed: ${e.response?.data || e.message}`);
      }

      await saveState(i);
      socket.emit('progress', { current: i+1, total: records.length });
      await new Promise(r => setTimeout(r, 500));
    }

    isRunning = false;
    socket.emit('log', shouldStop ? '⏸️ Processing stopped.' : '🎉 Processing complete!');
    socket.emit('done');
  } catch (err) {
    isRunning = false;
    socket.emit('log', `⚠️ Fatal error: ${err.message}`);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => 
  console.log(`🚀 Listening on http://0.0.0.0:${PORT}`)
);
