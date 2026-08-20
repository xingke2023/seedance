# Seedance AI Video Generation

## Project Structure

- `frontend/` — Next.js App Router (port 8113)
- `backend/` — Fastify API server (port 8112)
- Domain: `https://meeaws.xingke888.com` (本机 AWS 部署, nginx → frontend 8113, API 8112)
  - `https://sd.xingke888.com` 是同一部署的另一个域名
  - `https://mee.xingke888.com` 指向另一台服务器,不在本机

## Frontend

- Next.js 15 with App Router, TypeScript
- CSS Modules for styling (`page.module.css`)
- SSO auth via JWT (login at `/login`, tokens in localStorage)
- API client at `frontend/lib/api.ts` (proxies to backend via `/api/:path*`)

### Key Pages

- `/voiceover-v3` — Quick video generation (legacy single-video workflow)
- `/projects` — Project list (card grid)
- `/projects/[id]` — Project detail with video list
- `/projects/[id]/videos/[videoId]` — Video editor (script, shots, 3D camera, generation)
- `/tasks` — Task list with card layout, click-to-copy task ID
- `/billing` — Billing overview, compact one-line layout
- `/assets/real` — 真人资源 (LivenessFace assets)
- `/assets/virtual` — 虚拟人像 (AIGC assets)
- `/insurance` — 港险资料（案例 956 / 问答 1418，搜索 + 标签筛选 + 详情浮窗），入口在 TopNav
- `/tokens` — Token管理 (hidden from nav)
- `/keys` — 资源密钥 (hidden from nav)

### UI Conventions

- Flat style (no card/box wrappers on main content), similar to tasks page
- Mobile responsive with `@media (max-width: 768px)` breakpoints
- Collapsible sections with useState boolean toggles
- Primary color: `#2563eb` (blue) for action buttons
- Border buttons for secondary actions (e.g. 参数设置)
- Resource boxes: gray border `#e5e7eb`, uniform style
- Sticky params button below nav (top: 44px) on mobile
- TopNav: sticky, 44px height, dark background `#1e293b`

### Components

- `TopNav` — Navigation bar (首页, 港险资料, 真人头像, 虚拟头像, dropdown: 任务列表, 账单)
- `components/video-editor/CameraEditor` — Three.js 3D camera position editor
- `components/video-editor/types.ts` — Shared TypeScript interfaces (Shot, Video, CameraState, etc.)
- `AssetsPanel` — Shared assets panel component (exported from `app/assets/AssetsPanel.tsx`)
  - Used by both `/assets/real` and `/assets/virtual` with `tab` prop
  - Groups list from local DB, assets from remote FidelityAI API
  - Mobile: shows "真人头像组N" / "虚拟人像组N" instead of group ID
- `ParamsPanel` — Video params (model, resolution, voice, style, ratio, toggles)
- `MediaPanel` — Upload and display reference media (button in title row)
- `AssetLibrary` — Collapsible asset library (real/virtual)

### Voiceover-v3 Page Flow

1. **角色** — Select characters from project subjects (default: all project subjects)
2. **视频需求** — Input script text (or use AI生成 via DeepSeek to auto-generate)
3. **字幕(可选)** — Subtitle text + voice selector + TTS generation (Azure)
4. **参考素材** — Upload images/video/audio
5. **主体定义** — AI analyze subjects from uploaded media (Gemini Vision)
6. **一键生成分镜** — AI generates storyboard shots from script
7. **分镜视频生成** — Submit each shot to Seedance API for video generation
8. **分镜合并** — Merge videos + burn SRT subtitles + overlay TTS audio (ffmpeg)

### Key Features

- **Independent TTS**: Azure Cognitive Services (not Seedance built-in audio)
- **Subtitle burn-in**: ffmpeg burns SRT into merged video
- **Video caching**: Downloaded videos cached locally with metadata (duration)
- **Smart subtitle splitting**: Only breaks at punctuation, each shot audio < video duration
- **State persistence**: Video subjects + media items saved to DB (`video_subjects`, `video_media` tables)
- **Batch tasks**: PostgreSQL persistence for task history
- **JSON content ordering**: subjects first → asset images → uploaded images → videos → audio

## Backend

- Fastify with CORS enabled
- Routes: `/projects/*`, `/videos/*`, `/shots/*`, `/voiceover/*`, `/video/*`, `/assets/*`, `/manage/*`, `/upload`
- Environment: `.env` file (see `.env.example`)
- PostgreSQL database `mee2`, user `seedance_user`
- Tables: `users`, `projects`, `project_subjects`, `videos`, `video_subjects`, `shots`, `video_media`, `user_asset_groups`
- 提示词/资料库表（`lib_` 前缀，见「提示词与资料库」章节）
- Video cache at `backend/uploads/.video-cache/` (MP4 + JSON metadata)

### Database Schema (hierarchy: projects → videos → shots)

- `projects` — id(UUID), user_id, name, description, cover_url
- `project_subjects` — id(UUID), project_id(FK), label, description, image_url, asset_id (项目主体库)
- `videos` — id(UUID), project_id(FK), user_id, name, script, subtitle_input, style, ratio, params(JSONB), voice, audio_url, merged_video_url, status
- `video_subjects` — id(UUID), video_id(FK), subject_id(FK), UNIQUE (视频关联的主体)
- `shots` — id(UUID), video_id(FK), shot_number, title, description, prompt, subtitle, duration, camera fields, reference_images(JSONB), subjects(JSONB), task_id, task_status, video_url
- `video_media` — id(UUID), video_id(FK), media_type, url, name, sort_order
- `user_asset_groups` — id, user_id(FK), group_id(VARCHAR), group_type(VARCHAR), name, shared(BOOL), created_at
  - Links local users to remote FidelityAI asset groups
  - `shared=true` means visible to all users; otherwise only visible to owner
  - Groups list (`GET /assets/groups`) reads from this table only (no remote API call)
  - Creating/deleting groups writes to both remote API and this table

### Key Backend Endpoints

- `CRUD /projects` — Project management
- `CRUD /projects/:id/videos` — Videos within project
- `GET /videos/:id` — Full video with shots, media, and video_subjects
- `PUT /videos/:id` — Update video fields, subject_ids, media_items
- `CRUD /videos/:videoId/shots` — Shots within video
- `PUT /shots/:id` — Update shot (prompt, camera, subjects, task status)
- `POST /voiceover/generate-script` — AI generate video script (DeepSeek)
- `POST /voiceover/init` — Generate storyboard shots from script
- `POST /voiceover/tts` — Azure TTS audio generation
- `POST /voiceover/merge` — Concat videos + burn subtitles + mux audio
- `POST /voiceover/analyze-subjects` — Gemini Vision subject analysis
- `POST /video/generate` — Submit video generation task to Seedance API
- `GET /video/task/:taskId` — Poll task status (auto-caches on success)
- `GET /assets/groups` — List asset groups (local DB only, filtered by user_id)
- `POST /assets/groups` — Create AIGC group (remote + local)
- `DELETE /assets/groups/:groupId` — Delete group (remote + local, tolerates remote 404)
- `GET /assets/groups/:groupId/assets` — List assets in group (remote API)
- `POST /assets/groups/:groupId/assets` — Create asset (remote API, field: URL)
- `GET /assets/all` — List all assets for picker (remote, filtered by user's groups)
- `POST /assets/visual-validate/start` — Start H5 liveness verification
- `GET /assets/visual-validate/:sessionId` — Poll verification status (auto-links group to user on success)

## 提示词与资料库（并入自 fenjing-script）

原 Flask 项目 `/home/ubuntu/fenjing-script`（GitHub: xingke2023/prompt-eng）已移植进来，为**分镜脚本生成**提供提示词工程与素材支撑。原项目仍独立运行在 8129，两边数据已分家。

### 数据表（`mee2`，`lib_` 前缀）

| 表 | 条数 | 用途 |
|---|---|---|
| `lib_shot_presets` | 8 | 镜头预设（运动/景别/构图/光线/色调 + 英文片段） |
| `lib_style_presets` | 8 | 风格预设 |
| `lib_prompt_templates` | 10 | 提示词模板 |
| `lib_fragments` | 22 | 素材片段，`type` ∈ character/scene/action/lighting/quality |
| `lib_insurance_cases` | 956 | 港险案例（分镜取材用） |
| `lib_insurance_qa` | 1418 | 港险问答 |

历史与收藏（原 `prompts`/`storyboards`/`favorites`）未并入。

### 提示词引擎

- `backend/src/prompt/prompts.js` — 5 个 system prompt，**逐字移植**：`SINGLE_SHOT` / `QCZH`(起承转合) / `STORYBOARD` / `ENHANCE` / `NARRATION`(解说纪录片)。后四个规定了严格 JSON 输出结构，前端与分镜导入依赖，勿随意改写
- `backend/src/prompt/engine.js` — Anthropic SDK 封装，JSON 用 `jsonrepair` 兜底
- `backend/src/prompt/guide.js` — 提示词写作指南（结构化数据，非 HTML）

**模型**：`claude-sonnet-5`，走 `tokens.fidelityai.net` 代理（后端是 Bedrock）。该代理**没有 `claude-opus-5`**，sonnet-5 是可用的最强型号。用 `ANTHROPIC_MODEL` 可覆盖。
开启 adaptive thinking，`max_tokens` 同时封顶思考+正文，所以分镜类调用给到 16000。

### 两个正交维度

分镜生成有两个独立开关：

voiceover-v3 上「叙事短片 / 解说纪录片」是被提到页面层的生成器参数 —— **它只决定 `video_type`，不切换任何输入框**。「视频概念描述」始终是同一个 textarea，「字幕 / 配音」是独立区块（带音色选择和 TTS，不能被 radio 藏掉）。「专业分镜生成」按钮在「视频概念描述」标题行右侧，点开是**浮窗**（经 `createPortal` 挂到 `body`，避开页面的 sticky 头部和 overflow 容器；遮罩层透明只用来接外部点击，不遮挡也不锁页面滚动；Esc / 点外部关闭）。

| 参数 | 取值 | 说明 |
|---|---|---|
| `video_type` | `story`(叙事短片) / `narration`(解说纪录片) | 解说纪录片优先级最高，走 `NARRATION_SYSTEM`，每镜产出可直接配音的 `narration_script` |
| `narrative_structure` | `free`(自由) / `qczh`(起承转合) | 仅在叙事短片下生效；起承转合至少 4 镜 |

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/prompt/storyboard` | 多镜头分镜脚本（三种组合），返回严格 JSON |
| POST | `/prompt/generate` | 单镜头提示词（Markdown 输出） |
| POST | `/prompt/enhance` | 提示词优化（JSON 输出） |
| GET | `/prompt/model` | 当前使用的模型名 |
| GET | `/library/{shot-presets,style-presets,templates,fragments}` | 素材库，按 `use_count` 排序 |
| POST | `/library/use/:table/:id` | 使用计数自增（排序权重） |
| GET | `/library/cases`、`/library/cases/:id`、`/library/cases/tags` | 港险案例，支持 `q`/`tag`/`featured`/分页 |
| GET | `/library/qa`、`/library/qa/:id`、`/library/qa/tags` | 港险问答 |
| GET | `/library/guide` | 提示词写作指南 |

全部需登录。`/cases/tags` 必须注册在 `/cases/:id` 之前，否则被路由参数吃掉。

### 前端组件

- `components/library/StoryboardGenerator` — 分镜生成器弹窗。表单字段与 fenjing-script 原版一致：创作目标/整体基调/总时长/镜头数量/叙事结构/视频类型都是 **select**，**option 的 value 是英文短语**（如 `brand storytelling, emotional connection`），会原样拼进 user message 喂给模型 —— 别把它们换成中文自由文本。目标受众和核心信息是自由输入。支持「从港险案例库取材」自动填充概念，生成后先预览再导入分镜表
- `components/library/LibraryPanel` — 素材库面板，点击条目把英文片段追加到提示词框

两者都挂在 `/projects/[id]/videos/[videoId]` 编辑器上。

## Development

```bash
cd frontend && npm run dev  # port 8113
cd backend && node src/app.js  # port 8112
```

## Deployment

PM2 manages the production processes for seedance2.0 independently.

### Nginx

两个域名指向同一套服务 (frontend 8113 / backend 8112),配置文件都在仓库根目录并从 sites-enabled 软链:

| 域名 | 配置文件 |
|---|---|
| meeaws.xingke888.com | `nginx-meeaws.xingke888.com.conf` |
| sd.xingke888.com | `nginx-sd.xingke888.com.conf` |

- `location /api/` → `http://127.0.0.1:8112/`
- `location /uploads/` → `http://127.0.0.1:8112/uploads/`
- `location /` → `http://127.0.0.1:8113`

Cloudflare 代理在前,SSL 为 Full(非严格)模式,源站两个域名共用 `/etc/letsencrypt/live/sd.xingke888.com/` 证书。
meeaws 的 80 端口直接服务应用(不做 301),以免 CF 处于 Flexible 模式时产生重定向死循环。
如需为 meeaws 签发独立证书: `sudo certbot certonly --webroot -w /var/www/html -d meeaws.xingke888.com`
(配置里已保留 `/.well-known/acme-challenge/` 的 location)。

`WEBHOOK_BASE_URL` (backend/.env) 必须与对外域名一致 — 它用于拼接 `/uploads/` 公网地址传给 Seedance/FidelityAI。

### PM2 process names (seedance2.0)

- `seedance20-frontend` — Next.js frontend (port 8113)
- `seedance20-backend` — Fastify backend (port 8112)

### Rebuild & restart

```bash
cd /home/ubuntu/seedance2.0/frontend && rm -rf .next && npx next build && pm2 restart seedance20-frontend
pm2 restart seedance20-backend
```

### Troubleshooting

- **Port 8113 conflict**: `mee-frontend` (PM2 id 24) also uses port 8113 via `next dev`. Must keep it stopped (`pm2 stop mee-frontend`). If `seedance20-frontend` fails with EADDRINUSE, kill orphan processes: `lsof -ti :8113 | xargs kill -9`, then restart.
- **500 with "Cannot find module './XXX.js'"**: Corrupted `.next` build cache. Fix: `rm -rf frontend/.next && npx next build` then restart PM2.
- **PM2 stop doesn't kill child processes**: `pm2 stop` only stops the parent npm/npx process; `next dev`/`next-server` child processes may linger. Use `lsof -i :PORT` to find and kill them manually.

### Legacy (seedance old, /home/ubuntu/seedance/)

- `seedance2-frontend` — port 8115 (old version)
- `seedance2-backend` — port 8117 (old version)

## Git

- Avatar images (`frontend/public/avatars/`) are in .gitignore (too large for git)
- Remote: https://github.com/xingke2023/seedance
- Azure subtitle version: https://github.com/xingke2023/seedance-azure-subtile
