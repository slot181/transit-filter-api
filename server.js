const http = require('http');
const url = require('url');
const completions = require('./app/completions');
const images = require('./app/images');
const audio = require('./app/audio');
const models = require('./app/models');

// 创建请求处理函数
async function processRequest(req, res) {
  // 解析请求体
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  
  req.on('end', async () => {
    // 解析请求体为JSON（如果有）
    if (body && req.headers['content-type']?.includes('application/json')) {
      try {
        req.body = JSON.parse(body);
      } catch (e) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: {
            message: "无效的JSON格式",
            type: "invalid_request_error",
            code: 400
          }
        }));
        return;
      }
    } else {
      req.body = {};
    }

    // 路由请求到相应的处理函数
    const parsedUrl = url.parse(req.url, true);
    const path = parsedUrl.pathname;

    try {
      if (path === '/v1/chat/completions') {
        await completions(req, res);
      } else if (path === '/v1/images/generations') {
        await images(req, res);
      } else if (path === '/v1/audio/transcriptions') {
        await audio(req, res);
      } else if (path === '/v1/models') {
        await models(req, res);
      } else {
        // 处理404
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: {
            message: "路径不存在",
            type: "invalid_request_error",
            code: 404
          }
        }));
      }
    } catch (error) {
      console.error('Server error:', error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: {
          message: "服务器内部错误",
          type: "service_error",
          code: 500
        }
      }));
    }
  });
}

// 创建HTTP服务器
const server = http.createServer(processRequest);

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器已启动，监听所有网络接口，端口 ${PORT}`);
  console.log(`API路径:`);
  console.log(`- 聊天补全: http://<服务器IP>:${PORT}/v1/chat/completions`);
  console.log(`- 图像生成: http://<服务器IP>:${PORT}/v1/images/generations`);
  console.log(`- 音频转录: http://<服务器IP>:${PORT}/v1/audio/transcriptions`);
  console.log(`- 模型列表: http://<服务器IP>:${PORT}/v1/models`);
});

// 处理进程终止信号
process.on('SIGTERM', () => {
  console.log('收到SIGTERM信号，关闭服务器');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});
