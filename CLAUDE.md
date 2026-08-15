# Seedance AI Video Generation

## Project Structure

- `frontend/` — Next.js App Router (port 8113)
- `backend/` — Fastify API server (port 8112)
- Domain: `https://mee.xingke888.com` (nginx → frontend 8113, API 8112)

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

- `TopNav` — Navigation bar (首页, 项目, 真人资源, 虚拟人像, dropdown: 任务列表, 账单)
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

## Development

```bash
cd frontend && npm run dev  # port 8113
cd backend && node src/app.js  # port 8112
```

## Deployment

PM2 manages the production processes for seedance2.0 independently.

### Nginx (mee.xingke888.com)

Config: `/etc/nginx/sites-enabled/mee.xingke888.com.conf`

- `location /api/` → `http://127.0.0.1:8112/`
- `location /uploads/` → `http://127.0.0.1:8112/uploads/`
- `location /` → `http://127.0.0.1:8113`

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
