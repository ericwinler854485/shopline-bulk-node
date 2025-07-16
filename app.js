// app.js
const express       = require('express');
const fileUpload    = require('express-fileupload');
const { parse: csvParse } = require('csv-parse');
const fs            = require('fs');
const path          = require('path');
const axios         = require('axios');
const morgan        = require('morgan');
const { promisify } = require('util');

const app = express();
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname,'views'));

// handle file uploads up to 50 MB
app.use(fileUpload({ limits: { fileSize: 50 * 1024 * 1024 } }));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

function safeStr(value, def = '') {
  if (value === undefined || value === null) return def;
  return String(value).trim();
}

app.get('/', (req, res) => {
  res.render('index', { error: null, summary: null, successful: [], failed: [] });
});

app.post('/process', async (req, res) => {
  try {
    const { access_token, store_domain } = req.body;
    if (!req.files?.csv || !access_token || !store_domain) {
      return res.render('index', { error: 'All fields are required.', summary: null, successful: [], failed: [] });
    }

    // Save CSV
    const csvFile = req.files.csv;
    const csvPath = path.join(UPLOAD_DIR, csvFile.name);
    await csvFile.mv(csvPath);

    // Read & parse
    const fileContent = await promisify(fs.readFile)(csvPath, 'utf8');
    const records     = await promisify(csvParse)(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    // Shopline API client
    const apiBase = `https://${store_domain.replace(/^https?:\/\//,'')}/admin/openapi/v20251201`;
    const client  = axios.create({
      baseURL: apiBase,
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json',
        'User-Agent': 'ShoplineBulkOrderCreator/Node'
      },
      timeout: 30000
    });

    const successful = [];
    const failed     = [];

    for (let i = 0; i < records.length; i++) {
      const row = records[i];

      // build customer, shipping, billing, line_items, etc...
      const customer = {
        email:      safeStr(row.customer_email),
        first_name: safeStr(row.customer_first_name),
        last_name:  safeStr(row.customer_last_name),
        area_code:  safeStr(row.customer_area_code, '+1'),
        phone:      safeStr(row.customer_phone, '')
      };

      const ship = {
        address1:    safeStr(row.shipping_address1),
        address2:    safeStr(row.shipping_address2),
        city:        safeStr(row.shipping_city),
        province:    safeStr(row.shipping_state),
        country:     safeStr(row.shipping_country, 'United States'),
        country_code:safeStr(row.shipping_country_code, 'US'),
        zip:         safeStr(row.shipping_zip),
        first_name:  customer.first_name,
        last_name:   customer.last_name,
        email:       customer.email,
        phone:       customer.phone,
        company:     safeStr(row.shipping_company, '')
      };

      let billing = { ...ship, same_as_receiver: true };
      if (['yes','true','1'].includes(safeStr(row.billing_different).toLowerCase())) {
        billing = {
          address1:    safeStr(row.billing_address1, ship.address1),
          address2:    safeStr(row.billing_address2, ship.address2),
          city:        safeStr(row.billing_city, ship.city),
          province:    safeStr(row.billing_state, ship.province),
          country:     safeStr(row.billing_country, ship.country),
          country_code:safeStr(row.billing_country_code, ship.country_code),
          zip:         safeStr(row.billing_zip, ship.zip),
          first_name:  customer.first_name,
          last_name:   customer.last_name,
          email:       customer.email,
          phone:       customer.phone,
          company:     safeStr(row.billing_company, ship.company)
        };
      }

      const line_items = [];
      for (let j = 1; j <= 5; j++) {
        const title = safeStr(row[`product_${j}_name`]);
        const price = parseFloat(safeStr(row[`product_${j}_price`], '0'));
        const qty   = parseInt(safeStr(row[`product_${j}_quantity`], '1'), 10);
        if (title && price) {
          const item = {
            title,
            price: price.toFixed(2),
            quantity: qty,
            requires_shipping: true,
            taxable: true,
            sku: safeStr(row[`product_${j}_sku`], undefined)
          };
          line_items.push(item);
        }
      }
      if (!line_items.length) {
        failed.push({ row: i+1, error: 'No products', email: customer.email });
        continue;
      }

      // map payment method to financial_status
      const pm = safeStr(row.payment_method, 'COD').toUpperCase();
      let financial_status = 'unpaid';
      if (['PAID','ONLINE','CREDIT_CARD','PAYPAL'].includes(pm)) financial_status = 'paid';
      else if (['PENDING','PROCESSING'].includes(pm)) financial_status = 'pending';
      else if (['AUTHORIZED','AUTH'].includes(pm)) financial_status = 'authorized';

      const ship_price = parseFloat(safeStr(row.shipping_price,'0'));
      const note       = safeStr(row.order_note);
      const currency   = safeStr(row.currency,'USD');

      const order = {
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
        const apiRes = await client.post('/orders.json', order);
        const o = apiRes.data.order || {};
        successful.push({ row: i+1, order_number: o.name || o.id, email: customer.email });
      } catch (err) {
        failed.push({ row: i+1, error: err.response?.data || err.message, email: customer.email });
      }

      // throttle half‑second
      await new Promise(r => setTimeout(r, 500));
    }

    const summary = {
      total:  records.length,
      success: successful.length,
      failed:  failed.length,
      rate:   ((successful.length/records.length)*100).toFixed(1)
    };

    res.render('index', { error: null, summary, successful, failed });
  } catch (e) {
    console.error(e);
    res.render('index', { error: e.message, summary: null, successful: [], failed: [] });
  }
});

const PORT = process.env.PORT||3000;
app.listen(PORT, () => console.log(`🚀 Listening on http://0.0.0.0:${PORT}`));
