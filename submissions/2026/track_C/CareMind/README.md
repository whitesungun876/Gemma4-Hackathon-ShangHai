# CareMind

参赛组名：**CareMind Team**　｜　正式项目名称：**CareMind 失智症家庭照护 Agent**

面向失智症家庭照护场景的 AI Care Agent。CareMind 以 Gemma-family 模型能力为核心，演示家庭照护记录结构化、今日风险关注、低冲突沟通话术、复诊摘要整理，以及 Android 端侧隐私模式。项目不诊断、不处方、不判断是否需要检查，也不替代医生或急救服务。

## 1. 项目名称

正式项目名称：**CareMind 失智症家庭照护 Agent**

参赛组名：**CareMind Team**

团队成员：张媛、连婕妤、刘畅、郭鸿宇

参赛赛道：**赛道 C：Edge AI / Android 端侧 AI**

主项目仓库：<https://github.com/hyczy0809/CareMind>

## 2. 项目简介

失智症家庭照护中，大量关键变化发生在医院之外：夜间频繁起床、拒药、少食、怀疑东西被偷、反复要回家、照护者睡眠不足和情绪崩溃。家属往往只能靠记忆和零散聊天记录，在复诊时努力说清“最近到底发生了什么”。

CareMind 把这些混乱的日常记录整理成一个可追踪的照护闭环：

```text
一句话记录发生了什么
-> AI 整理成睡眠 / 饮食 / 用药 / 情绪行为 / 安全 / 照护者状态
-> 今日照护给出今晚最值得关注的小行动
-> 沟通话术帮助家属用更低冲突的方式回应
-> 复诊准备生成医生能快速理解的摘要
-> 隐私模式让敏感记录优先留在 Android 设备本地处理
```

项目包含三个核心页面：

- **今日照护**：展示今日最值得关注的事项、行动三态、陪伴活动和照护者支持。
- **智能记录**：输入或语音记录照护事件，生成结构化日志、风险信号和沟通话术。
- **复诊准备**：聚合近 7 天 / 30 天记录、病历/检查/用药资料，生成可复制复诊摘要。

项目提供两种运行形态：**云端 Agent 工作流** 与 **Android 端侧隐私模式**。默认演示数据均为脱敏数据，不包含真实患者、家庭或医疗资料。

## 3. 在线演示链接

当前公开演示后端：

<https://caremind-1039168666325.us-west1.run.app>

健康检查：

```bash
curl https://caremind-1039168666325.us-west1.run.app/health
```

模型目录接口：

```bash
curl https://caremind-1039168666325.us-west1.run.app/api/models
```

说明：CareMind 的主要演示形态是 Android 真机 App 与本地 Web 开发预览。公开地址目前提供后端 API、模型目录和 Agent 接口；完整前端请见主项目仓库。

## 4. 演示视频链接

公开视频：

<https://www.bilibili.com/video/BV1hFEg6ZEVb>

<p align="center">
  <a href="https://www.bilibili.com/video/BV1hFEg6ZEVb">
    <img src="docs/caremind-demo-video-preview.png" alt="CareMind demo video preview" width="860" />
  </a>
</p>

视频文件不提交到 Git 历史中，README 使用可点击预览图链接到公开视频。

## 5. 项目仓库链接

GitHub 仓库：

<https://github.com/hyczy0809/CareMind>

比赛提交 PR：

<https://github.com/gdgshanghai/Gemma4-Hackathon-ShangHai/pull/57>

## 6. 运行方式

### 方式一 · 使用已部署后端快速验证

```bash
curl https://caremind-1039168666325.us-west1.run.app/health
curl https://caremind-1039168666325.us-west1.run.app/api/models
```

当前生产演示后端部署在 Cloud Run：

```text
https://caremind-1039168666325.us-west1.run.app
```

常用接口：

```http
GET  /health
GET  /api/models
GET  /api/models/{filename}/meta
GET  /api/models/{filename}
POST /api/care-workflow
POST /api/reports/follow-up
POST /v1/chat/completions
```

### 方式二 · 本地启动后端

环境要求：Python 3.10+。

```bash
cd source/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --host 127.0.0.1 --port 8090
```

冒烟测试：

```bash
curl http://127.0.0.1:8090/health
curl http://127.0.0.1:8090/api/models
```

### 方式三 · Docker 启动后端

```bash
cd source/backend
cp .env.example .env
docker build -t caremind-backend .
docker run --rm \
  --env-file .env \
  -e PORT=8080 \
  -p 8080:8080 \
  caremind-backend
```

冒烟测试：

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/models
```

如需使用托管模型目录流程，请在 `.env` 中配置：

```env
CAREMIND_GCS_MODEL_BUCKET=caremind-498713-models-asia
CAREMIND_GCS_MODEL_PREFIX=models
CAREMIND_GCS_DYNAMIC_CATALOG=1
CAREMIND_GCS_MODEL_DELIVERY=redirect
```

### 方式四 · Android 真机 / Edge AI 隐私模式

完整 Android 工程见主项目仓库。本提交目录保留与 C 赛道评审相关的关键 Native 和 TypeScript 端侧模块。

Android 编译环境：

- Expo SDK 52
- React Native 0.76
- Android compileSdk 35
- Android minSdk 24
- 推荐 JDK 17
- MediaPipe GenAI runtime：`com.google.mediapipe:tasks-genai:0.10.35`

构建示例：

```bash
cd frontend
npm install
npm run typecheck
cd android
NODE_ENV=production \
EXPO_PUBLIC_CAREMIND_API_URL=https://caremind-1039168666325.us-west1.run.app \
./gradlew :app:assembleRelease
```

硬件演示步骤：

1. 在 Android 手机上安装 CareMind APK。
2. 打开 **Settings / Privacy Mode**。
3. 刷新模型目录。
4. 从后端下载 LiteRT 模型。
5. 关闭 Wi-Fi 和移动网络。
6. 输入一条敏感照护记录：

```text
外婆夜里醒了四次，一直说有人偷钱，晚饭只吃了几口，妈妈也很累。
```

7. 展示 CareMind 在本地返回非诊断性照护观察和低负担行动建议。

## 7. 技术栈

前端：

- Expo + React Native + Expo Router
- Android Kotlin native bridge：Gemma model lifecycle、system speech recognition
- 本地 / 云端 inference router：`source/frontend/lib/inference`

后端：

- FastAPI
- OpenAI-compatible `/v1/chat/completions` Agent route
- Typed `/api/*` business endpoints
- Cloudflare AI Gateway / OpenAI-compatible model adapter
- Google ADK cloud agents：照护工作流、Memory、风险、复诊摘要工具

端侧与模型：

- Gemma 3 1B `.litertlm` via Android native module
- 支持 `.litertlm` / `.task` 动态模型目录
- Google Cloud Storage 模型分发
- XML structured output contract + parser + deterministic fallback

部署：

- Google Cloud Run 后端
- Google Cloud Storage 模型文件
- Docker / local uvicorn
- Android release APK

## 8. 项目亮点

**Edge AI 是产品需求，不是装饰性技术点。**
失智症照护记录常常包含家庭冲突、患者状态、照护者崩溃时刻等敏感内容。CareMind 的隐私模式支持在 Android 真机加载 Gemma LiteRT 模型，让更敏感的照护记录优先留在本机处理。

**动态端侧模型目录，APK 不用反复重打包。**
App 调用 `GET /api/models` 获取可下载模型。Cloud Run 后端扫描 Google Cloud Storage 中的 `.litertlm` / `.task` 文件，新增模型后用户点击刷新即可看到。

**云端 Agent 路径包含真实 Tool Calling。**
`source/backend/my_agent/cloud_agents.py` 注册照护、风险、Memory 和复诊摘要工具；`source/backend/my_agent/cloudflare_openai_model.py` 把函数声明转成 OpenAI-compatible `tools` / `tool_choice: auto`，并把模型返回的 `tool_calls` 映射回 ADK function calls。

**照护工作流不是聊天回复，而是产品数据。**
CareMind 把模型输出转成 typed product data：结构化日志、今日关注、行动三态、沟通话术、复诊摘要和 Memory 候选。前端不是直接展示一段聊天文本。

**医疗边界内建到产品流程。**
系统不输出诊断、处方、用药调整或检查决策。病历、检查、用药资料进入复诊摘要前，需要家属确认。危机场景转向紧急支持或医生。

**演示数据脱敏，真实部署可控。**
默认使用脱敏演示数据；API Key 通过 `.env` 注入；大模型文件通过 GCS 或 Git LFS 管理，不进入普通 Git 历史。

## 9. 交付物说明

| 交付物 | 位置 / 链接 |
|---|---|
| 主项目仓库 | <https://github.com/hyczy0809/CareMind> |
| 比赛提交 PR | <https://github.com/gdgshanghai/Gemma4-Hackathon-ShangHai/pull/57> |
| 公开视频 | <https://www.bilibili.com/video/BV1hFEg6ZEVb> |
| 演示后端 | <https://caremind-1039168666325.us-west1.run.app> |
| 技术报告 | [TECHNICAL_REPORT.md](TECHNICAL_REPORT.md) |
| 硬件演示说明 | [EDGE_HARDWARE_DEMO.md](EDGE_HARDWARE_DEMO.md) |
| Demo 分镜 | [docs/demo_storyboard.md](docs/demo_storyboard.md) |
| Demo 录制指南 | [docs/recording_guide.md](docs/recording_guide.md) |
| 后端入口 | [source/backend/main.py](source/backend/main.py) |
| OpenAI-compatible Agent route | [source/backend/openai_compat.py](source/backend/openai_compat.py) |
| Agent / Memory 工作流 | [source/backend/my_agent](source/backend/my_agent) |
| Android 端侧模型桥接 | [source/frontend/android/app/src/main/java/com/caremind/app/gemma](source/frontend/android/app/src/main/java/com/caremind/app/gemma) |
| 本地 / 云端推理路由 | [source/frontend/lib/inference](source/frontend/lib/inference) |

目录结构：

```text
CareMind/
├── README.md
├── TECHNICAL_REPORT.md
├── EDGE_HARDWARE_DEMO.md
├── requirements.txt
├── docs/
│   ├── caremind-demo-video-preview.png
│   ├── demo_storyboard.md
│   └── recording_guide.md
└── source/
    ├── backend/
    │   ├── main.py
    │   ├── openai_compat.py
    │   ├── my_agent/
    │   ├── requirements.txt
    │   ├── Dockerfile
    │   └── .env.example
    └── frontend/
        ├── app.json
        ├── package.json
        ├── lib/inference/
        ├── lib/speech/android-speech.ts
        └── android/
```

脱敏与安全声明：

- 仓库只包含脱敏演示数据，不包含真实患者、家庭、医院、账号或生产系统数据。
- 真实 API Key 仅应存于本地 `.env`，仓库只提供 `.env.example`。
- 大模型文件应通过 Google Cloud Storage 或 Git LFS 管理，不应作为普通 Git blob 提交。
- CareMind 不是医疗器械，不提供诊断、处方、检查决策或急救替代服务。
- 涉及走失、自伤、伤人、急性意识改变、严重受伤等场景时，应联系当地紧急服务或医生。

## 为什么选择 C 赛道

CareMind 的核心洞察不是“AI 可以总结文本”，而是：**最敏感的照护时刻往往发生在家里、深夜、照护者自己的手机上**。因此 Edge AI 是产品需求，而不是装饰性技术点。CareMind 希望让家属在不把每一段原始私密记录都交给云端的情况下，也能获得结构化照护理解和下一步支持。
