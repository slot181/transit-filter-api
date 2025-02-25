# 内容审核API

这是一个支持内容审核和API转发功能的服务，兼容OpenAI API格式。

## 功能特点

- 聊天补全API
- 图像生成API
- 音频转录API
- 模型列表API
- 内容审核功能

## Docker部署

### 服务器配置

在部署前，请确保服务器已开放相应端口：

1. 对于Ubuntu/Debian系统：
   ```bash
   sudo ufw allow 3000/tcp
   ```

2. 对于CentOS/RHEL系统：
   ```bash
   sudo firewall-cmd --permanent --add-port=3000/tcp
   sudo firewall-cmd --reload
   ```

3. 对于云服务器，请在控制台安全组中开放3000端口

### 使用Docker Compose（推荐）

1. 复制环境变量模板并填写配置
   ```bash
   cp .env.example .env
   # 编辑.env文件，填写必要的配置
   ```

2. 使用Docker Compose启动服务
   ```bash
   docker-compose up -d
   ```

3. 查看日志
   ```bash
   docker-compose logs -f
   ```

### 手动构建和运行

1. 构建Docker镜像
   ```bash
   docker build -t content-moderation-api .
   ```

2. 运行Docker容器
   ```bash
   docker run -p 3000:3000 --env-file .env content-moderation-api
   ```

## 环境变量说明

| 变量名 | 说明 | 示例 |
|--------|------|------|
| AUTH_KEY | API认证密钥 | sk-yourauthkey |
| FIRST_PROVIDER_URL | 审核服务API地址 | https://api.example.com |
| FIRST_PROVIDER_KEY | 审核服务API密钥 | sk-firstproviderkey |
| FIRST_PROVIDER_MODELS | 审核服务模型列表 | gpt-3.5-turbo,gpt-4,...... |
| SECOND_PROVIDER_URL | 主要服务API地址 | https://api.another-example.com |
| SECOND_PROVIDER_KEY | 主要服务API密钥 | sk-secondproviderkey |
| MAX_RETRY_TIME | 最大重试时间(毫秒) | 30000 |
| RETRY_DELAY | 重试延迟(毫秒) | 5000 |
| STREAM_TIMEOUT | 流式响应超时(毫秒) | 60000 |
| MAX_RETRY_COUNT | 最大重试次数 | 5 |
| PORT | 服务器端口 | 3000 |

## API使用

服务启动后，可以通过以下端点访问API：

- 聊天补全: `http://localhost:3000/v1/chat/completions`
- 图像生成: `http://localhost:3000/v1/images/generations`
- 音频转录: `http://localhost:3000/v1/audio/transcriptions`
- 模型列表: `http://localhost:3000/v1/models`

所有请求都需要在Header中添加认证信息：
```
Authorization: Bearer YOUR_AUTH_KEY
```
