module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: {
        message: "Method not allowed",
        type: "invalid_request_error",
        code: 405
      }
    });
  }

  const acceptHeader = req.headers['accept'] || '';
  if (acceptHeader.includes('text/html')) {
    res.setHeader('Content-Type', 'text/html');
    res.status(200).end(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>API Status</title>
      </head>
      <body>
        <h1>API is running successfully</h1>
        <p>Timestamp: ${new Date().toISOString()}</p>
      </body>
      </html>
    `);
  } else {
    res.status(200).json({
      status: "API is running successfully",
      timestamp: new Date().toISOString()
    });
  }
};