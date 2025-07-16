// app.js
const express     = require('express');
const fileUpload  = require('express-fileupload');
const csvParse    = require('csv-parse');
const fs          = require('fs');
const path        = require('path');
const axios       = require('axios');
const morgan      = require('morgan');
const { promisify } = require('util');

const app = express();
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname,'views'));

// Increase payload size if needed
app.use(fileUpload({ limits: { fileSize: 50 * 1024 * 1024 } }));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

function safeStr(value, def = '') {
  if (value === undefined || value === null) return def;
  return String(value).trim();
}

app.get('/', (req, res) => {
  res.render('index', { error: null, summary: null });
});

app.post('/process', async (req, res) => {
  try {
    const { access_token, store_domain } = req.body;
    if (!req.files?.csv || !access_token || !store_domain) {
      return res.render('index', { error: 'All fields are required.', summary: null });
    }

    // Save uploaded CSV
    const csvFile = req.files.csv;
    const csvPath = path.join(UPLOAD_DIR, csvFile.name);
    await csvFile.mv(csvPath);

    // Read and parse CSV
    const fileContent = await promisify(fs.readFile)(csvPath, 'utf8');
    const records = await promisify(csvParse)(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    // Prepare API client
    const apiBase = `https://${store_domain.replace(/^https?:\/\//,'')}/admin/openapi/v20251201`;
    const client = axios.create({
      baseURL: apiBase,
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json',
        'User-Agent': 'ShoplineBulkOrderCreator/Node'
      },
      timeout: 30000
    });

    // Process each row
    const successful = [];
    const failed = [];

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      // Build order payload exactly as Python does...
      const customer = {
        email: safeStr(row.customer_email),
        first_name: safeStr(row.customer_first_name),
        last_name: safeStr(row.customer_last_name),
        area_code: safeStr(row.customer_area_code, '+1')
      };
      if (row.customer_phone) customer.phone = safeStr(row.customer_phone);

      const ship = {
        address1: safeStr(row.shipping_address1),
        city: safeStr(row.shipping_city),
        province: safeStr(row.shipping_state),
        country: safeStr(row.shipping_country, 'United States'),
        country_code: safeStr(row.shipping_country_code,'US'),
        zip: safeStr(row.shipping_zip),
        first_name: customer.first_name,
        last_name: customer.last_name,
        email: customer.email
      };
      if (row.shipping_address2) ship.address2 = safeStr(row.shipping_address2);
      if (row.shipping_company) ship.company = safeStr(row.shipping_company);
      if (row.customer_phone) ship.phone = safeStr(row.customer_phone);

      // Billing
      let billing = { ...ship, same_as_receiver: true };
      if (['yes','true','1'].includes(safeStr(row.billing_different).toLowerCase())) {
        billing = {
          address1: safeStr(row.billing_address1, ship.address1),
          city: safeStr(row.billing_city, ship.city),
          province: safeStr(row.billing_state, ship.province),
          country: safeStr(row.billing_country, ship.country),
          country_code: safeStr(row.billing_country_code, ship.country_code),
          zip: safeStr(row.billing_zip, ship.zip),
          first_name: customer.first_name,
          last_name: customer.last_name,
          email: customer.email
        };
        if (row.billing_address2) billing.address2 = safeStr(row.billing_address2);
        if (row.billing_company) billing.company = safeStr(row.billing_company);
      }

      // Line items
      const line_items = [];
      for (let j = 1; j <= 5; j++) {
        const name  = safeStr(row[`product_${j}_name`]);
        const price = parseFloat(safeStr(row[`product_${j}_price`], '0'));
        const qty   = parseInt(safeStr(row[`product_${j}_quantity`], '1'));
        if (name && price) {
          const item = {
            title: name,
            price: price.toFixed(2),
            quantity: qty,
            requires_shipping: true,
            taxable: true
          };
          if (row[`product_${j}_sku`]) item.sku = safeStr(row[`product_${j}_sku`]);
          line_items.push(item);
        }
      }
      if (!line_items.length) {
        failed.push({ row: i+1, error: 'No valid products' });
        continue;
      }

      // Payment status mapping
      const pm = safeStr(row.payment_method,'COD').toUpperCase();
      let financial_status = 'unpaid';
      if (['PAID','ONLINE','CREDIT_CARD','PAYPAL'].includes(pm)) financial_status='paid';
      else if (['PENDING','PROCESSING'].includes(pm)) financial_status='pending';
      else if (['AUTHORIZED','AUTH'].includes(pm)) financial_status='authorized';

      const ship_price = parseFloat(safeStr(row.shipping_price,'0')) || 0;
      const note       = safeStr(row.order_note);
      const currency   = safeStr(row.currency,'USD');

      // Build the final payload
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
          }
        }
      };
      if (note) orderData.order.order_note = note;
      if (ship_price > 0) {
        orderData.order.shipping_line = {
          title: 'Standard Shipping',
          price: ship_price.toFixed(2),
          code: 'STANDARD'
        };
      }

      try {
        const apiRes = await client.post('/orders.json', orderData);
        const ord    = apiRes.data.order || {};
        successful.push({
          row: i+1,
          order_id: ord.id,
          order_number: ord.name||ord.id,
          customer_email: customer.email
        });
      } catch (err) {
        failed.push({
          row: i+1,
          error: err.response?.data || err.message,
          customer_email: customer.email
        });
      }

      // Throttle
      await new Promise(r => setTimeout(r, 500));
    }

    // Prepare summary
    const summary = {
      total: records.length,
      success: successful.length,
      failed: failed.length,
      rate: ((successful.length/records.length)*100).toFixed(1)
    };

    // Render results
    res.render('index', { 
      error: null, 
      summary, 
      successful, 
      failed 
    });

  } catch (e) {
    console.error(e);
    res.render('index', { error: e.message, summary: null });
  }
});

const PORT = process.env.PORT||3000;
app.listen(PORT, () => console.log(`🚀 Listening on http://0.0.0.0:${PORT}`));
