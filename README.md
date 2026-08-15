# Seedance Azure Subtitle

基于 Seedance 视频生成项目的 **独立字幕烧制版本**。

## 与主项目的区别

本项目的语音和字幕是 **独立生成、独立烧制** 的，不使用 Seedance API 自带的音频/字幕功能：

- **Azure TTS** — 使用 Azure Cognitive Services 生成配音语音（支持多种音色）
- **独立烧制字幕** — 合并视频时通过 ffmpeg 将 SRT 字幕烧录进视频，叠加 TTS 音频
- **音频可预听** — 生成分镜视频前可试听配音，支持更换音色重新生成
- **视频可复用** — 修改字幕/语音后无需重新生成分镜视频，直接重新合并

## 其他改动

除字幕烧制逻辑外，本项目还修复和改进了很多内容：

- 视频下载缓存（避免重复下载，记录精确时长）
- 视频生成成功后自动下载到本地并更新数据库
- 分镜数据持久化（刷新页面不丢失）
- 字幕智能断句（只在标点处断开，每个分镜音频 < 视频时长）
- 多处 bug 修复和逻辑优化

## 如果需要其他字幕方案

如果要改成 Seedance 自带的语音字幕（API 直接生成），建议基于本项目修改，因为除了字幕逻辑外，本项目已经修复了大量其他问题。只需要：

1. 将 `generateAudio` 改回 `true`
2. 移除 TTS 端点和音频预听 UI
3. 移除合并时的字幕烧制逻辑（或保留烧制但使用 API 返回的音频）

## 技术栈

- **Frontend** — Next.js 15 (App Router) + TypeScript
- **Backend** — Fastify + Node.js
- **TTS** — Azure Cognitive Services Speech (Neural)
- **视频处理** — ffmpeg (concat, subtitle burn-in, audio mux)
- **数据库** — PostgreSQL (batch tasks)

## 部署

```bash
cd frontend && npm run dev   # port 8111
cd backend && node src/app.js  # port 8112
```

环境变量见 `backend/.env.example`，需要配置 `AZURE_SPEECH_KEY` 和 `AZURE_SPEECH_REGION`。
