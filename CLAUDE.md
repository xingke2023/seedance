# Seedance AI Video Generation

## Project Structure

- `frontend/` — Next.js App Router (port 8113)
- `backend/` — Fastify API server (port 8112)
- Domain: `https://meeaws.xingke888.com` (本机 AWS 部署, nginx → frontend 8113, API 8112)
  - `https://sd.xingke888.com`、`https://v.xingke888.com`、`https://demo1.fidelityai.net` 是同一部署的其它域名
  - `https://mee.xingke888.com` 指向另一台服务器,不在本机

## Frontend

- Next.js 15 with App Router, TypeScript
- CSS Modules for styling (`page.module.css`)
- SSO auth via JWT (login at `/login`, tokens in localStorage)
- API client at `frontend/lib/api.ts` (proxies to backend via `/api/:path*`)

### Key Pages

- `/voiceover-v3` — 单条视频的完整工作流（概念 → 分镜 → 逐镜生成 → 合并），**日常主要用这个页面**
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

1. **视频类型** — 叙事短片 / 解说纪录片（只切 `video_type`，两种共用同一个 textarea，见「两个正交维度」）
2. **角色** — Select characters from project subjects (default: all project subjects)
3. **视频概念描述** — 唯一的 textarea（或用 AI生成 via DeepSeek）。标题行右侧是
   「专业分镜生成」浮窗 —— 那只是**参数面板**，生成由页面上的按钮触发
4. **配音（可选）** — 音色选择 + Azure TTS。**只在解说纪录片下出现**（叙事短片的人声来自视频自身）
5. **参考素材** — Upload images/video/audio
6. **主体定义** — AI analyze subjects from uploaded media（`/voiceover/analyze-subjects`）
7. **生成分镜脚本** — 走 `/prompt/storyboard-async`，**后台任务**，可以离开页面（见「分镜生成是后台任务」）
8. **分镜视频生成** — Submit each shot to Seedance API for video generation
9. **分镜合并** — Merge videos + burn SRT subtitles；解说纪录片再叠 Azure 音轨，
   叙事短片保留分镜自带的对白原声（ffmpeg）

### Key Features

- **Independent TTS**: Azure Cognitive Services (not Seedance built-in audio) — 逐镜合成并与画面对齐，见「Azure 语音与分镜对齐」
- **Subtitle burn-in**: ffmpeg burns SRT into merged video
- **Video caching**: Downloaded videos cached locally with metadata (duration)
- **Smart subtitle splitting**: Only breaks at punctuation, each shot audio < video duration
- **State persistence**: Video subjects + media items saved to DB (`video_subjects`, `video_media` tables)
- **Batch tasks**: PostgreSQL persistence for task history
- **JSON content ordering**: subjects first → asset images → uploaded images → videos → audio
  —— 这个顺序就是提示词里 `@图片N` / `@视频N` / `@音频N` 的编号，**不能重排**

## Backend

- Fastify with CORS enabled
- Routes: `/projects/*`, `/videos/*`, `/shots/*`, `/voiceover/*`, `/video/*`, `/assets/*`, `/prompt/*`, `/library/*`, `/manage/*`, `/upload`
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
- `shots` — id(UUID), video_id(FK), shot_number, title, description, prompt, subtitle, duration, ratio,
  shot_type, lighting, mood, camera_movement, camera fields, roll_type, voice_style,
  reference_images(JSONB), subjects(JSONB), image_url, task_id, task_status, video_url, local_url,
  video_duration, task_error
  - ⚠️ 几列是**窄 varchar**：`shot_type`/`lighting` 只有 30，`mood`/`camera_movement` 100，
    `roll_type` 10，`voice_style` 20 —— 而这些值大多来自模型自由生成的英文短语。
    `routes/shots.js` 的 `clip()` 按列宽截断（插入和更新都过），否则一句长光线描述就能让
    整批保存报 `value too long for type character varying(30)`
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

老的 `/voiceover/init`（中文 prompt、结尾强加「无水印，无Logo」这类内容否定）已随本次
手艺引入**整条删除** —— 分镜生成统一走 `/prompt/storyboard`，前端早已不再调用它。

### 提示词引擎

- `backend/src/prompt/prompts.js` — 6 个 system prompt（**只有系统提示词**，拍摄手艺在 `skills/`）。前 5 个**逐字移植**：`SINGLE_SHOT` / `QCZH`(起承转合) / `STORYBOARD` / `ENHANCE` / `NARRATION`(解说纪录片)。后四个规定了严格 JSON 输出结构，前端与分镜导入依赖，勿随意改写。
  第 6 个 `DIALOGUE` **是新写的，不是移植**：`STORYBOARD`/`QCZH` 只产画面、没有台词字段，
  而换引擎前的老分镜接口会逐镜生成字幕 —— 所以叙事短片走**两步生成**，第二步补台词。
  台词是**旁白与对白穿插**（旁白占四分之一到三分之一，管空镜/转场/时间跳跃/开场收尾，
  对白管当场发生的冲突与态度；一镜之内一般只用一种，两种都要时旁白在前对白在后），
  每句带 `speaker`（用外貌特征指代，不用人名）和 `type`
  （`dialogue` 角色开口 / `narration` 画外旁白）—— **两种都会写进 `prompt_en`**，
  对白进 lip-sync 块、旁白进画外音块，字幕两类一起烧。
- `backend/src/prompt/engine.js` — Anthropic SDK 封装，JSON 用 `jsonrepair` 兜底
- `backend/src/prompt/skills/` — 拍摄手艺，一个 `.md` 一段（见「拍摄手艺（skills）」章节）
- `backend/src/prompt/guide.js` — 提示词写作指南（结构化数据，非 HTML）

**模型**：`claude-sonnet-5`，走 `tokens.fidelityai.net` 代理（后端是 Bedrock）。该代理**没有 `claude-opus-5`**，sonnet-5 是可用的最强型号。用 `ANTHROPIC_MODEL` 可覆盖。
开启 adaptive thinking，`max_tokens` 同时封顶思考+正文，所以分镜类调用给到 24000。
**必须走流式**（`messages.stream().finalMessage()`）—— `max_tokens` 一旦大到「可能跑超 10 分钟」，
SDK 会直接拒掉非流式请求；分镜实测 33-80s（skill 越装越多、每镜输出越长，耗时也跟着涨），
拿的仍是完整消息，调用方无感。

### 分镜生成是后台任务

一次分镜实测 **33-80 秒**（模型要写 N 段 150-220 词的英文提示词，还带 adaptive thinking），
同步请求撑不住：切走页面、手机锁屏、Next 代理超时都会让它白跑。所以走任务：

- `POST /prompt/storyboard-async` 立刻返回 `jobId`（~150ms），真正的生成用 `fastify.inject`
  在后台打自己的 `/storyboard`（**记得转发 Authorization**，那条路由自己会查 `request.user`）
- `GET /prompt/storyboard-status/:jobId` 轮询。**取结果不删任务** —— 刷新、重复轮询都要能再拿到，
  靠 30 分钟 TTL 过期。任务存在内存里（和 `/voiceover/merge-async` 同一套路），后端重启会丢，
  所以过期状态单独给 `expired` 而不是 `failed`
- 前端把 `jobId` 记在 `localStorage`（连同 `videoId`，回来时要对得上，别把 A 视频的结果写进 B），
  `dataLoaded` 之后自动接着轮询。**拿到结果之后的后处理**（转 shots、配音、落库）抽成了
  `finishStoryboard()` —— 结果可能是回到页面时才取到的，那时 `handleInit` 早退出了
- 轮询请求本身失败（断网）不终止任务，下一次 tick 再试

### 两个正交维度

分镜生成有两个独立开关：

voiceover-v3 上「叙事短片 / 解说纪录片」是被提到页面层的生成器参数 —— **它只决定 `video_type`，不切换任何输入框**。页面只有**一个 textarea**，两种视频类型共用同一份文本（存在 `script`）。字幕怎么来，由视频类型决定：

| 视频类型 | `subtitleInput` |
|---|---|
| 解说纪录片 | = textarea 的内容（那份文本本身就是解说词/字幕） |
| 叙事短片 | 空 —— 这份文本只是概念描述，字幕交给后端按脚本自动生成 |

镜像发生在两处：日常输入走 `setConceptText`，**切换视频类型那一刻**由一个 effect 同步一次。该 effect 有两个约束，改动时注意：只能认类型变化（跟着 `script` 跑会把分镜导入写进 `subtitleInput` 的字幕覆盖掉），且首次挂载不能跑（否则会清掉从库里读出来的字幕）。

**字幕管线本身没动** —— `ttsScript`、落库的 `subtitle_input`、时长估算全部照旧读 `subtitleInput`，只是它的来源从自己的输入框换成了共享框。下方「配音（可选）」（音色选择 + TTS）**只在解说纪录片下出现** —— 叙事短片的字幕为空，没有可配音的文本。「专业分镜生成」按钮在「视频概念描述」标题行右侧，点开是**浮窗**（经 `createPortal` 挂到 `body`，避开页面的 sticky 头部和 overflow 容器；遮罩层透明只用来接外部点击，不遮挡也不锁页面滚动；Esc / 点外部关闭）。

| 参数 | 取值 | 说明 |
|---|---|---|
| `video_type` | `story`(叙事短片) / `narration`(解说纪录片) | 解说纪录片优先级最高，走 `NARRATION_SYSTEM`，每镜产出可直接配音的 `narration_script` |
| `narrative_structure` | `free`(自由) / `qczh`(起承转合) | 仅在叙事短片下生效；起承转合至少 4 镜 |

### 叙事短片的两步生成

`video_type=story` 时 `/prompt/storyboard` 会连发两次模型调用：

1. `STORYBOARD` / `QCZH` 出画面（`prompt_en`、首末帧、构图色调…）；`DIALOGUE_CRAFT` 要求
   至少 2/3 的镜头有角色在画面里说话，且看得清脸 —— 第一步排不出能开口的人，第二步的对白就没处放
2. `DIALOGUE` 按第一步的镜头编号+时长+景别+A/B-roll+画面说明**逐镜写对白**（角色定义一并传过去，
   `speaker` 才描述得出画面里真实存在的人），结果同时写进三处：
   - `shot.subtitle` = 该镜所有台词拼接（烧字幕用）
   - `shot.dialogue` = 结构化的 `{speaker, speaker_en, type, text}[]`
   - `shot.prompt_en` 末尾追加 `Dialogue (spoken on camera, lip-synced):` + 每行 `X says/replies/continues: “台词”`
     —— **句式必须是英文的 `says:`**（Seedance 靠它识别台词），**引号里的中文原文不能翻译**
     （口型按引号里的字对齐，翻了就改动了要说出口的字）。`X` 取模型给的 `speaker_en`
     （英文外貌指代，用词要和该镜 `prompt_en` 里对这个人的描述对得上），漏写才退回中文 `speaker`
   **`narration`（画外旁白）行也一样进 prompt_en**，另起一个 voiceover 块
   （`Off-screen voiceover (narrator is NOT visible in frame, no lip sync…)`）——
   它原来只进字幕，成片就是有字无声。字幕两类都烧，声音也就两类都要有；
   旁白也算一个说话人，`DIALOGUE_SYSTEM` 要为它出一句音色描述，音色锁照贴。
   有 `dialogue` 台词的镜头 `roll_type` 一律回改成 `a_roll`（有人在画面里说话，按定义就是 A-roll），
   所以 roll_type 兜底移到了第二步**之前**

第二步用 `effort: 'low'`，实测约 5s。**失败不阻断** —— 宁可交付没台词的分镜，也不要整个请求失败。
解说纪录片自带 `narration_script`，跳过第二步。

**字幕就是台词的准绳**（`prompt/speech.js` 的 `syncSpeechWithSubtitle`）：结构化的 `dialogue`
没有落库（`shots` 只有 `subtitle` 一列），页面上改一次字幕，prompt 末尾那段台词就对不上了 ——
画面里的人念旧词、烧上去的字幕是新词。所以**提交生成任务时按字幕重建台词块**：
- 比对只看可读内容（标点空白不算），一致就原样返回
- 音色行（`X 使用 @音频N …` / `Voice of X: …`）保留不动 —— 那是音色锁
- **对白还是画外旁白，看画面里有没有人**（prompt 里有没有 `<主体N>`），不看 `roll_type`：
  存量分镜有一批当初被判成旁白、可字幕明明是第一人称台词，人就站在画面里 —— 那就该让他开口
- 原来没有台词块的（旁白从前不进 prompt，成片有字无声）在这一步补上；
  **重建时若原来没有音色行，按角色定义里的音色绑定补一句**
  （`角色「X」绑定@图片1、音色@音频1` → `<主体1> 使用 @音频1 …的音色说话`，
  音色描述取素材说明里那条音频的说明）—— 缺这一句，同一个角色逐镜还是不同嗓子

**叙事短片的人声来自视频自身**，不是 Azure TTS：
- `generateAudio` 跟着视频类型走（切换类型的那个 effect 里同步，与 `subtitleInput` 同一处）：
  **叙事短片 = true**（对白已写进 prompt，关掉就只剩哑画面）、**解说纪录片 = false**
  （成品音轨来自 Azure 旁白，视频自带音频用不上）。已保存的视频仍以库里 `params.generateAudio` 为准
- **`videoType` 必须一起落进 `params`**：切换类型的 effect 刻意跳过首次挂载，所以打开一条
  已存的视频时它不会跑。类型不存的话每次重开都回到叙事短片，而 `generateAudio` 却从库里
  读了出来 —— 于是出现「叙事短片 + `generate_audio: false`」的哑画面。
  没存过 `videoType` 的老数据：类型按 `subtitle_input` 空不空反推，`generateAudio` 以类型为准
  （那个 false 是当年默认值的残留）；存过的行说明是新数据，尊重用户手动开关
- 生成分镜后**不调 `/voiceover/tts`**（只有解说纪录片调），分镜时长直接取模型给的
- 合并时**不传 `audioUrl`** —— `/voiceover/merge` 的 `audioUrl` 已改为可选：不传就保留各分镜
  视频自带的音轨（concat 前给缺音轨的分镜补等长静音，否则 concat demuxer 会因流布局不一致失败），
  字幕按每镜实际时长排（`buildShotSRT`），只烧字幕不覆盖音频

### 技能库（skills）—— 按情况自动选用

分镜提示词的手艺**不写在代码里**，写成 `backend/src/prompt/skills/*.md`，一个文件一段手艺。
front matter 用 `when_*` 声明生效条件，**加一条手艺 = 丢一个 `.md` 进去，不用改代码**（启动时读一次）。

`skills/index.js` 从一次分镜请求归纳出上下文，逐条比对条件，命中的按 `priority` 拼到 user message 末尾：

| 上下文字段 | 来源 |
|---|---|
| `video_type` / `narrative_structure` / `shot_count` / `total_seconds` | 请求参数（`duration_total` 解析成秒） |
| `ratio` | voiceover-v3 的画幅设置（**页面必须把 `ratio` 一起发过来**，否则竖屏/横屏那两条都不装） |
| `has_subjects` | 传没传 `subject_definitions` |
| `has_reference_media` | `image_descriptions` 里有没有 `视频N` / `音频N` |
| `has_dialogue` | 叙事短片才有 |
| `has_slogan` | 传没传 `slogan`（要渲进画面的广告语） |

`style`（视觉风格）不参与 skill 选择，但**必须一起发过来** —— 它拼进 user message，
不给的话模型会跟着参考图的风格走（见 `style-lock`）。

条件是 AND；逗号分隔 = 命中其一；数值用 `_lte` / `_gte`；**上下文缺这个字段一律不匹配**
（宁可少装一条，也不要在信息不全时把不相干的规则塞给模型）。

| priority | skill | 条件 |
|---|---|---|
| 10 | `seedance-2-0-prompting` | 始终 |
| 11 | `style-lock` | 始终 |
| 12 | `subtitle-safe-area` | 始终 |
| 13 | `in-video-slogan` | 传了 `slogan` |
| 14 | `default-guardrails` | 始终 |
| 15 | `hook-and-retention` | 始终 |
| 20 | `story-dialogue` | 叙事短片 |
| 25 | `character-anchoring` | 有绑定角色 |
| 26 | `reference-media` | 有参考视频/音频 |
| 30 | `broll-craft` / `narration-broll` | 叙事短片 / 解说纪录片 |
| 35 | `narration-voice` | 解说纪录片 |
| 36 | `narration-voice-style` | 解说纪录片 |
| 40 | `vertical-short-form` / `cinematic-widescreen` | 竖屏 / 横屏 |
| 90 | `roll-type-field` | 始终 |

官方完整规范存在 `/home/ubuntu/doc/SKILL_Seedance2.0.md`（Seedance 2.0 提示词优化器 skill）。
已采纳：一镜一运镜、断句防歧义、人物禁用三视图（只用大头照+全身照）、优先低缓小动作、
画质包/稳定包/双胞胎兜底、主体定义挑稳定静态特征、台词语种统一与发音兜底。
**尚未采纳、需要决策的三处冲突见 `skills/SOURCES.md` 的「与官方规范的分歧」。**

每条的内容、出处、以及**刻意没照搬的部分**（多镜头切分、5-8s B-roll 节奏、语速 4-5 字/秒、
成片混音参数…）全部记在 `skills/SOURCES.md`。上游是参考项目 OpenMontage（`/home/ubuntu/OpenMontage`），
取舍标准只有一条：**这条手艺对 Seedance 2.0 的单条生成有没有用**。

排查用：`GET /prompt/skills`（带 query 可预览某组情况装哪几条），
`POST /prompt/storyboard` 的返回里也带 `skills: []`，是这次实际装载的清单。

**音色锁**：`DIALOGUE_SYSTEM` 为每个角色产出一句英文 `voice_en`，后端把它**一字不改**地贴进
该角色说话的每一个镜头（`Voice of X: …`）。我们每个分镜是一次独立生成，不锁音色，
同一个角色逐镜声音都不一样。

**`speaker_en` 也要归一**（和角色定义原文锁同一个道理）：`X says: “…”` 里的 `X` 是模型
逐句自由写的英文指代，这镜 `the man in the navy shirt`、下镜 `the young office worker` ——
每镜独立生成，Seedance 就当成两个人配两把嗓子。后端按 speaker 统计出现最多的那个写法
（同频取更具体的长句），把全片所有台词行换成它，音色行里的 `X` 用的是同一个。

**没绑就自动配**：生成分镜那一刻，页面给每个还没绑音色的角色从预设库挑一条钉死
（`pickPresetVoice`，按角色卡文字猜性别和年龄段 → 音色库的 `青年/少年_少女/中年/儿童/老年`
分组 + 性别；挑没被占用的，同性别同龄的角色用 index 错开不撞车）。挑好的音频当场入列参考素材，
`voice_bindings` 用**刚算好的那份**拼（state 还没落地，所以 `subjectContext` 抽成了纯函数
`buildSubjectContext`，能拿新值直接构建）。音频配额（`MEDIA_LIMITS.audio`）用完就不再配，
剩下的角色退回模型写的英文音色描述。

**页面上绑音色**：剧本分析的角色卡上有「选音色」，从已上传的参考音频里挑一条
（按 **url** 绑，不按 uid —— 重开页面 media 的 uid 会变），存进 `params.scriptAnalysis[].linkedAudioUrl`。
分镜请求多带一个 `voice_bindings`（一行一个 `角色「X」使用@音频N`），后端拿它**盖掉模型自己挑的
`audio_ref`** —— 挑错一次，那个角色整条片子都用别人的嗓子。为了对上人，`DIALOGUE_SYSTEM` 的
`voices` 多要一个 `subject_label`（出场角色里的名字）；漏写就退回模型自己挑的编号，
只绑了一个角色且全片只有一个人说话时也认。`voice_zh` 漏写则用该条音频在页面上的说明兜底。

**预设音色库**：方舟体验中心的素材清单扒在仓库根的 `materials/`（`all_materials.json` +
`audio_presets.json`，另有 74 个 mp3 的本地副本）。后端 `GET /library/materials[?kind=audios|images|videos]`
（`src/lib/materials.js`，启动后缓存一次）归一成 `{name, category, url, thumb}`：
音色 80 条（青年/少年_少女/中年/儿童/老年，带 base64 头像和时长）、
图片 71 张（服饰/环境/画风/角色）、视频 35 段（动作/运镜）。
⚠️ JSON 里的 `videoUrl` / `imageUrl` **是坏的**（少了 `动作/`「服饰/」这层子目录、扩展名也不对），
能用的地址是 `thumbnail` 去掉 `?x-tos-process=…`；音频的 `audioUrl` 是对的。
文件托管在火山的公开 TOS 上，直接把地址交给 Seedance，不必转存到 `/uploads`。
两个入口都能用：角色卡的「选音色」（搜索 + 试听，选中后**先入列参考素材**才有 `@音频N` 编号，
多个角色共用同一条只入列一次），以及「参考素材」标题行的**「素材库」浮窗**
（视频/音频/图片三个页签 + 搜索，点一下即入列，受 `MEDIA_LIMITS` 上限约束）。
缩略图不落库（音色头像是 base64，太大）—— 列表渲染时按 url 现查 `presetThumbByUrl`，
视频没有现成缩略图时用 `?x-tos-process=video/snapshot,t_0,h_600` 现取首帧。

**图片编号与音色编号对齐**：绑了音色的角色，音频会被排到和它的图片编号同一位
（`@图片1` 的角色 → `@音频1`），不属于角色的音频（环境音之类）排在后面。角色都选了音色时
就是严格一一对应；对不上也不靠猜 —— 提示词里逐条写明了谁用哪条：
`角色「小李」绑定@图片1、音色@音频1，外貌描述：…`、`音频1：角色「小李」的音色 — …`，
素材说明里还有一句总的要求（形象引 `@图片N`、音色引 `@音频M`，两个都要写）。
`anchor.js` 的 `DEF_LINE` 已放宽到能吃掉 `绑定@图片1` 后面那截音色绑定。

**真正的克隆只有 `@音频N`**：一句英文音色描述只能把音色范围收窄，收不死。挂一段该角色的
参考音频，`DIALOGUE_SYSTEM` 会给出 `audio_ref` + 中文音色描述，提示词里变成
`X 使用@音频N低厚温润…的音色说话`（Seedance 官方约定：只给编号不描述音色会飘）。
提交生成任务时每一镜都带上全部参考素材，所以 `@音频N` 的编号在各镜之间是一致的。

### 画面内不能有字

字幕是合并时用 ffmpeg 烧进去的，Seedance 生成的画面里一个字都不该有 —— 模型自己再渲一层就重叠。
踩过的坑：**提示词里只要出现 `subtitle` / `caption`，模型就会真的渲一行字幕**，
哪怕那句话的本意是「把这块留给字幕」。所以：

- 留位的英文写法钉死为 `lower third of frame kept clean and unobstructed`
  （原来是 `... kept clean for subtitles`，正是它把字幕招出来的）
- 每一镜的否定串必须带 `no subtitles, no captions, no on-screen text, no watermark, no logo`
- 对白块的标题写明 `spoken audio only, never rendered as on-screen text or subtitles`
  —— prompt_en 里带引号的中文台词同样会诱导模型把台词渲成画面字幕
- `NARRATION_SYSTEM` 原来有个 `subtitle_text`（"屏幕叠加的关键词/核心数据"）字段，
  **全项目无人读取**，却在直接要求画面内文字 —— 已删；`composition` 的示例串也一并改掉
- 唯一例外是 `in-video-slogan`（传了 `slogan` 才装载），那一镜的否定串改成
  `no other on-screen text besides the slogan`

### B-roll 手法

`NARRATION_SYSTEM` 里本来就有这套（情绪对应、下三分之一留白），抽成 `broll-craft` 后**叙事短片也用**
（解说纪录片跳过，避免和它自带的重复）。叙事短片在它之外再叠 `story-dialogue`（对白优先），
两者并不打架：B-roll 那几条管的是空镜怎么拍，对白管的是有人的镜头要看得见脸。

**分镜卡上的 景别 / 运镜**：模型给的是影视术语代码（`MCU`/`WS`）和自由英文短语
（`handheld, unstabilized…`），而卡片里这两项是 `<select>`，值对不上 option 就渲染成**空白**。
导入和读库时都过一遍 `normalizeShotSize` / `normalizeCameraMove`（page.tsx 里选项表下面）
归一化到中文选项；认不出来的原样保留，select 会为它补一个 option，不会显示成空。
落库时 `shot_type` / `lighting` 也要一起写（曾漏掉，导致重开后景别永远是空）。
「光影氛围」是自由文本，直接存模型给的 `lighting` 英文描述。

`roll-type-field` 要求每镜输出 `roll_type`（`a_roll` = 画面里有人正对镜头说话，其余 `b_roll`）——
系统提示词的 JSON 结构里没这个字段，所以必须显式要；后端兜底填 `b_roll`。
落库到 `shots.roll_type`，voiceover-v3 的分镜行上显示彩色标签。

### Azure 语音与分镜对齐（解说纪录片）

Seedance 只接受 **4-15 的整数秒**，而中文每个字的实际时长差很多（数字、标点停顿、专有名词）。
所以不能整条念完再按字数比例切分镜 —— 那样能差一两秒，画面切了话没说完。

反过来做：**让语音去贴合整数秒的画面**。`/voiceover/tts` 逐镜处理：

1. 每镜单独合成一次，用 **wordBoundary 的最后一个词说完的时刻**当语音长度
   （不是 mp3 文件长度 —— Azure 句尾自带 0.5-1s 静音，用文件长度会把每镜都撑大、还会把变速算歪）
2. `round(说完时刻 + 0.45)` 取整秒 = 这一镜的画面时长（夹在 4-15）
3. 用 SSML `prosody rate` 在 **±8%** 内微调语速把这一秒填满（8% 以内听不出来）
4. 尾音留 0.15s 衰减后 `atrim`，再 `apad` 补静音到整秒；逐镜拼成一条

拼出来的音轨长度**严格等于各分镜时长之和**，每镜尾部稳定留 0.45-0.6s 换气（正好也是 craft 要的「揭示后留白」）。
没有台词的空镜补等长静音。加速到上限仍装不进 15 秒的镜头，音频照原样保留、
画面时长顶到它，并在返回里给 `overflowShots`（该拆镜或改短旁白，**不会**悄悄截掉说到一半的话）。

`/voiceover/merge` 再补最后一环：视频每条可以带 `targetDuration`（按语音排好的秒数）——
生成回来的分镜常有 ±0.1~0.3s 偏差，逐镜累积后面的画面就和旁白错开。偏差在 1.5s 以内的
直接贴回目标秒数（长了截断、短了定格补足），超过 1.5s 不动（那说明这一镜本身就没按预期生成）。

字幕仍按 `wordBoundaries` 对齐 —— 语音、字幕、画面三者现在挂在同一条时间轴上。

**换音色不用重做分镜视频**（`lockDurations`）：默认是「画面跟着语音走」—— 逐镜时长按语音重算，
换个语速不同的音色就会逼着把分镜视频重做一遍。所以 `/voiceover/tts` 多了一个开关：
`lockDurations: true` 时**反过来让语音去贴合 `shots[].duration`**（已经生成好的画面秒数）。

- 前端在**已有分镜视频生成成功**时自动带上这个开关（`handleRegenTTS` 里判断 `tasks[i].status`，
  这个状态刷新页面后会从 `shots.task_status` 恢复，所以重开也认）
- 锁时长下语速调整范围从 ±8% 放宽到 **±18%** —— 听得出来一点，但比重做视频划算
- 实在塞不进去的镜头：最多把该镜顶长 1.5s（合并那步用定格补足），仍装不下就进 `overflowShots`，
  页面点名让你改短这几镜旁白或只重做这几镜
- 逐镜时长仍会写回 `shots` 并落库 —— 不写回的话合并按旧时长贴画面、音轨按新时长拼，会一路错开

配完直接「分镜合并」即可，合并会用新音轨重烧字幕、重新覆盖音频，分镜视频原样复用。

**逐镜情绪（多情感配音）**：`narration-voice-style` 这条 skill 要求每镜输出
`voice_style`（`calm` / `serious` / `worried` / `warm` / `uplifting`，后端兜底填 `calm`），
TTS 转成 Azure 的 `<mstts:express-as style=… styledegree=1.0~1.2>`。
`styledegree` 压在 1.2 以内，再高就像在念广告。**音色不支持该风格时自动退回无风格重合成一次**
（宁可没情绪也要有旁白）—— 所以不用维护「哪个音色支持哪些风格」的表。
落库到 `shots.voice_style`，voiceover-v3 的分镜行上显示彩色情绪标签。

### 角色锚定

`/prompt/storyboard` 接受 `subject_definitions` 和 `image_descriptions`，拼进 **user message**（系统提示词逐字移植，不动），要求模型在 `prompt_en` 里用 `@图片N` 引用角色。返回前后端从 `prompt_en` 正则提取出 **`image_refs: number[]`** 挂到每个 shot 上 —— 从文本反解而不是让模型多输出一个字段，因为系统提示词规定了严格 JSON 结构，模型漏写新字段的概率远高于漏写它刚写进 prompt 的引用。

**外貌只留静态特征**：`/voiceover/analyze-script` 的提示词明写了不许带道具、动作、表情、
场景（`✗ …面带职业微笑，手边放着计算器和文件`），后端再用 `keepStaticLooks()` 按标点切句兜一道 ——
命中「手里/拿着/放着/桌上/正在/坐在/微笑/表情/眼神…」的整句丢掉，但**戴在身上的配饰不算道具**
（眼镜、手表、耳环留着）。整段都被判成道具时原样返回，宁可不干净也不要空。
理由：这段文字会被下面的原文锁**逐镜一字不改**地贴进 `prompt_en`，写了道具就等于逼模型每镜摆同一个道具、
挂同一个表情。老数据不会自动清洗 —— 重跑一次剧本分析即可。

**角色定义原文锁**（和音色锁同一套路）：角色定义句由**后端逐镜统一贴**，不再采信模型自己写的那句。
每一镜是独立生成，定义句必须每镜重写一遍，而模型逐镜自由发挥的结果是同一个人这镜「穿深蓝色衬衫」、
下镜「穿深蓝色衬衫袖口挽起」，标签编号还可能和图片编号对不上 —— 脸和衣服就跟着一镜一变。

- 原文来自页面的 `subject_definitions`（一行一个角色：`角色「X」绑定@图片N，外貌描述：…`）。
  voiceover-v3 用**剧本分析的 `appearance`** 作原文，没分析过才退回主体自带 `description`；
  性格不进定义句（定义要挑不随剧情变的静态特征）。**必须压成一行** —— 后端按行解析
- 后端 `lockSubjectAnchors()`（`routes/prompt.js`）把模型写的 `将@图片N中…定义为<主体M>，…；`
  整句换成 `将@图片N中<原文>定义为<主体N>`，贴回原处（前面是运镜画幅、后面是锁定短语，
  两头不动）。模型漏写定义句、只用 `<主体N>` 或 `@图片N` 指代的，锚定句补在最前面
- **标签编号归一到图片编号**：模型把 `@图片2` 的人叫成 `<主体1>` 时，整镜的标签一并换掉
  （先落占位符再换，否则 1↔2 互换会自己撞上自己）
- 外貌写着「见图片」「未提供」的角色不锁 —— 贴一句空定义还不如让模型照着图写；
  没在 `subject_definitions` 里出现的图片编号（参考素材）原样不动
- 模型仍旧被要求写定义句：让它写是为了逼它想清楚这一镜有谁出场，句子本身不作数
- **三道闸**：分镜生成时锁一次（`/prompt/storyboard`）、提交生成任务时再锁一次
  （`/video/generate` 收 `subject_definitions`，返回锁好的 `prompt`，页面回写进 shot）——
  存量分镜和手改过的 prompt 只经过第二道；存量数据另有 `backend/scripts/relock-shot-anchors.js`
  （默认演练，`--apply` 才写库，`--video <id>` 限定一条，可重复跑）
- **没有原文时的兜底** `harvestDefs()`：主体没填描述、也没做过剧本分析的老数据，
  就从这条视频**自己的分镜**里挑写得最全的那句定义当原文，全片统一到它 ——
  没有可依的原文时，一致比准确更要紧
- `@图片N` 的编号来自 `GET /videos/:id` 返回的 `video_subjects` 顺序，那条查询已经钉了
  `ORDER BY vs.created_at, vs.id` —— 不加就是堆顺序，重排一次角色就锚到别人的图上

**素材引用**：Seedance 提示词用 `@图片N` / `@视频N` / `@音频N` 指代 content 里第 N 个
该类型素材（对应 content 数组里第 N 个 `image_url` / `video_url` / `audio_url`，三类各自从 1
开始编号）。后端按类型分别正则提取成 `image_refs` / `video_refs` / `audio_refs`
（提取正则 `[<@]?图片\s*(\d+)\s*>?` —— `@图片1`、旧写法 `<图片1>`、裸写 `图片1` 都认，
库里存量分镜用的是尖括号那套）。**尖括号只留给 `<主体N>`** —— `<>` 是音效的符号位
（`<远处传来狗叫声>`），这是按官方规范在 2026-08-20 统一改的。前端 `subjectContext` 和提交生成任务时的
素材说明都按类型分别编号。

Seedance 2.0 官方约定里另有几条写进了 skills（出处见 `skills/SOURCES.md`）：
**重要素材前置**（越要精准参考的素材在提示词里放得越靠前）、
**多图指代同一主体**（`提取 @图片1 @图片2 @图片3 的相机…展示正面侧面以及背面`，
人物则写清哪张管脸、哪张管妆造）、
**`@音频N` + 中文音色描述克隆音色**（`使用@音频1低厚温润带细碎颗粒感中年男声的音色说…`，
只写编号不描述音色会飘）。
**多图参考**：一镜可以同时点多张图，每张承担不同职能（主体多视角、场景图、服装图、道具图、
分镜构图、标识图），要逐张写清管什么；**编号 = 上传顺序，全片不可重排**（编号错位比不引用更糟）；
标识类图片可以钉固定位置，但别钉在下三分之一（留给后期字幕）。
**主体定义**：`将 @图片1 中穿红色连衣裙的女人定义为 <主体1>`，定义后每次提到都用同一标签；
多主体分别定义、标签唯一稳定；未定义的简单场景写 `<主体N>@图片N`；
**不得用 Asset ID 代替 `@图片N`**（模型关联不上素材内容）。
**风格锁定**（`style-lock`）：每镜都要写风格约束词 —— 写实参考图配非写实目标风格
且提示词没强调时会漂回真人写实。为此 `style` 现在会随分镜请求一起发给后端，
`① 开场声明` 里的 `photorealistic, 35mm film grain` 也标明了只适用写实风格。
**画面内广告语**（`in-video-slogan`，传了 `slogan` 才装）：按
「文字内容+出现时机+出现位置+出现方式，文字特征」写，只放收尾镜 ——
这是本项目唯一允许出现在生成画面里的文字，字幕仍旧后期烧。

**`@图片N` 的编号必须两条链路一致**：voiceover-v3 的 `subjectContext`（带图主体在前、参考素材在后）
和视频编辑器页用的是同一套编号规则，各算各的一旦漂移，角色就会锚到别的图上。
导入时按 `image_refs` 反查回主体，填进分镜的 `subjects`。

### 待办 / 已知取舍

- **兜底包让模型逐镜复写很浪费**：画质包/稳定包/双胞胎兜底/字幕否定都是固定样板，
  由后端在拿到结果后统一追加能省掉约四分之一输出量，也就是四分之一的等待时间。**未做**
- **分镜任务存在内存里**，后端重启就丢（返回 `expired`）。要重启不丢得落库
- **官方规范里还有两条分歧没定**：绝对秒数 vs 镜头序号、`{台词}` vs `X says:` ——
  见 `skills/SOURCES.md` 的「与官方规范的分歧」
- **`slogan` 后端已支持、前端没有输入口**：页面上的 `banner` 是 ffmpeg 后期烧的贴片文字，
  和画面内广告语是两套机制，要复用还是新加输入框未定
- **官方的「编辑视频 / 延长视频」两类任务一个都没接**：其中「向后延长 @视频N」
  可以在分镜时长不够时替代重做，需要新接口和 UI

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/prompt/storyboard` | 多镜头分镜脚本（三种组合），返回严格 JSON。可传 `subject_definitions` / `image_descriptions` 做角色锚定 |
| POST | `/prompt/storyboard-async` | 同上，但立刻返回 `jobId`，生成在后台跑 |
| GET | `/prompt/storyboard-status/:jobId` | `processing`(带 `elapsed` 秒) / `done`(带 result) / `failed` / `expired` |
| GET | `/prompt/skills` | 当前装了哪些拍摄手艺、何时生效、出处 |
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

- `components/library/StoryboardGenerator` — 分镜生成的**参数面板**（浮窗），自身不发起生成 —— 生成统一由页面上那个「生成分镜脚本」按钮触发，参数经 `onSettingsChange` 上抛给宿主。表单字段与 fenjing-script 原版一致：创作目标/整体基调/总时长/镜头数量/叙事结构/视频类型都是 **select**，**option 的 value 是英文短语**（如 `brand storytelling, emotional connection`），会原样拼进 user message 喂给模型 —— 别把它们换成中文自由文本。目标受众和核心信息是自由输入。概念取自页面的 textarea；港险案例从 TopNav 的 `/insurance` 页浏览
- `components/library/LibraryPanel` — 素材库面板，点击条目把英文片段追加到提示词框

两者都挂在 `/projects/[id]/videos/[videoId]` 编辑器上。

## Development

```bash
cd frontend && npm run dev  # port 8118 (dev)
cd backend && node src/app.js  # port 8112
```

### Dev 与生产并存（同一个仓库目录）

生产的 `next start` 和 dev 的 `next dev` **不能共用 `.next`** —— `next dev` 一起来就会清掉
生产正在读的构建产物，8113 直接挂掉。所以 `next.config.ts` 里 `distDir` 走
`NEXT_DIST_DIR`，dev 用独立目录：

```bash
cd frontend && NEXT_DIST_DIR=.next-dev pm2 start npm --name seedance20-frontend-dev --update-env -- run dev
```

- dev 前端：8118（PM2 `seedance20-frontend-dev`），构建产物在 `.next-dev/`
- **后端共用生产的 8112**（`next.config.ts` 的 rewrite，可用 `BACKEND_PORT` 覆盖）——
  也就是 dev 上的操作直接写生产库 `mee2`
- 后端没有 dev 模式，改 `backend/src/**` 仍要 `pm2 restart seedance20-backend`
- `experimental.proxyTimeout` 必须设大（600s）—— Next 的 rewrite 代理**默认 30s 超时**，
  超时会 abort 上游并给浏览器返回纯文本 `Internal Server Error`，而分镜生成要 35-60s。
  生产碰不到：nginx 的 `location /api/` 直连 8112，压根不经过 Next 的代理

## Stripe 订阅支付

`/billing` 页上的「充值」由人工扫码（微信/支付宝二维码 + 「联系管理员确认到账」）换成了
**Stripe 按月订阅**：付款成功后 webhook 自动给 `users.quota` 加次数。扫码那套保留为
弹窗里折叠的「其他支付方式」，大陆用户仍走人工。

### 额度语义

订阅到账是 **`quota += credits`（累加）**，不是「每月重置」—— `used` 是累计值且从不清零，
剩余次数 = `quota - used`。改成重置就得连 `used` 一起重置，会把历史用量抹掉。

### 套餐

写在 `backend/src/lib/stripe.js` 的 `PLANS` 里（人民币，金额单位是「分」）：
基础版 ¥199/100次、专业版 ¥499/300次、旗舰版 ¥999/800次。
**换币种要重建 price**（Stripe 的 price 币种不可改），`stripe-setup-plans.js` 按
`plan_key + currency` 找现成的、商品跨币种复用；旧币种的 price 记得归档。
**Price ID 走 env**（`STRIPE_PRICE_BASIC` / `_PRO` / `_ULTRA`），调档位不用改代码。
`node backend/scripts/stripe-setup-plans.js` 演练（不联网），加 `--apply` 才真去 Stripe
建商品和价格并打印 env 片段；已建过的按 `metadata.plan_key` 复用，不会重复建。

### 接口（`backend/src/routes/billing.js`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/billing/plans` | 订阅套餐 + 一次性次数包 + `one_time_methods` + `enabled`（有没有配密钥）+ 每档 `configured`（有没有 Price ID） |
| GET | `/billing/subscription` | 当前订阅、剩余额度、到账流水 |
| POST | `/billing/checkout` | 传 `plan` 建订阅 Session、传 `pack` 建一次性 Session，返回 `url` 供前端跳转 |
| POST | `/billing/portal` | Stripe 客户门户（改套餐/退订/发票） |
| POST | `/billing/stripe/webhook` | Stripe 回调 |
| POST | `/webhooks/buy` | **同一个 handler 的别名** —— Stripe 后台里配的就是这个路径 |

### 域名

站点绑了第三个域名 **`v.xingke888.com`**（`nginx-v.xingke888.com.conf`，与 meeaws / sd 同一套服务）。
它比另外两个多一个 `location /webhooks/` → 8112，因为 Stripe 回调地址是
`https://v.xingke888.com/webhooks/buy`，不在 `/api/` 前缀下。
`APP_BASE_URL`（Checkout 付完跳回的地址）也指向它。

### 几个必须这么写的地方

- **验签要原始报文**：`attachRawBodyParser()` 在插件封装作用域内换掉 `application/json`
  的 parser，把 buffer 挂到 `req.rawBody` 的同时照常解出 JSON 给同插件其它路由用。
  nginx 那条 location 不能改写 body
- **幂等靠 `billing_events` 的主键**：收到事件先 `INSERT ... ON CONFLICT DO NOTHING` 抢占，
  抢不到就是重投，直接返回。Stripe 会重复投递同一事件，充值不能重复入账
- **还要按付款对象再去重一次**：`billing_events.source_id`（订阅是发票 ID，次数包是
  Checkout Session ID）上有部分唯一索引，撞了就跳过发放。因为同一笔款可能由两条不同事件送达：
  `invoice.paid` / `invoice.payment_succeeded` 是两条，次数包的
  `checkout.session.completed` / `checkout.session.async_payment_succeeded` 也是两条 ——
  事件 ID 不同，主键去重拦不住
- **次数包要看 `payment_status`**：支付宝/微信是异步确认的，`checkout.session.completed`
  可能在 `unpaid` 状态就来了，这时不能发额度，等 `checkout.session.async_payment_succeeded`
- **处理失败要把占位删掉**再返回 500，否则 Stripe 重投时会被当成重复事件跳过 —— 钱收了额度没到
- **额度只在 `invoice.paid` 发放**，不在 `checkout.session.completed`：首期发票同样会触发
  `invoice.paid`，两边都加就是双倍。续费也走这条，所以每个账期自动到账
- **续费发票上没有 session 的 metadata**，`user_id` 必须挂到 `subscription_data.metadata` 上，
  否则第二个月就追不回是谁付的（兜底还有 `billing_customers` 反查和 `billing_subscriptions` 反查）
- **Stripe 2025 年挪过字段**：`invoice.subscription` → `invoice.parent.subscription_details.subscription`，
  `line.price` → `line.pricing.price_details.price`，`subscription.current_period_end` →
  `subscription.items.data[0].current_period_end`。SDK 固定在一个 API 版本，但账号后台可以单独设，
  所以 `invoiceSubscriptionId()` / `subscriptionPeriodEnd()` 这几个 helper 两种形状都认
- webhook 路由**不走鉴权**（Stripe 不带 Authorization 头），靠签名验身份
- **结账页的邮箱预填**靠 Stripe customer 上的 `email`。`ensureCustomer()` 建号时写入，
  已存在的每次结账前对一次并补写 —— 老 customer 可能建于用户还没绑邮箱时。
  注意 `authMiddleware` 里 `request.user` 取的是 UPDATE 之前的行，SSO 首次带来新邮箱的
  那一次请求读到的还是旧值，下一次才生效

### 两条购买路径（支付宝/微信的硬限制）

**支付宝和微信在 Stripe 里是一次性支付方式，不能用于订阅扣款** —— 实测报
`The payment method \`alipay\` cannot be used in \`subscription\` mode.`。
所以 `/billing` 上有两条并行的路：

| | 模式 | 支付方式 | 额度 |
|---|---|---|---|
| 按月订阅（`PLANS`） | `mode: 'subscription'` | 仅银行卡 | 每账期自动到账 |
| 一次性次数包（`PACKS`） | `mode: 'payment'` | 卡 / 支付宝 / 微信 | 买断，一次性到账 |

次数包定价比同额度订阅高一档（¥249/¥599/¥1199 对 ¥199/¥499/¥999），
否则没人会选自动续费。

**查支付方式开没开要看对地方**：`accounts.retrieve().capabilities` 是 Connect 账号的概念，
直连账号在那里查不到 alipay/wechat_pay（会误判成没开通）。正确的地方是
`paymentMethodConfigurations.list()`，看默认配置里各方式的 `display_preference.value`。

微信支付还要额外传 `payment_method_options: { wechat_pay: { client: 'web' } }`，不传会报错。

### 数据表

- `billing_customers` — user_id ↔ stripe_customer_id（一对一，复用它客户门户才看得到历史订单）
- `billing_subscriptions` — 订阅状态、当前账期结束时间、是否已约定到期停止
- `billing_events` — 事件去重锁，兼作到账流水（`credits_granted` / `amount` / `currency`）

## Deployment

PM2 manages the production processes for seedance2.0 independently.

### Nginx

四个域名指向同一套服务 (frontend 8113 / backend 8112),配置文件都在仓库根目录并从 sites-enabled 软链:

| 域名 | 配置文件 |
|---|---|
| meeaws.xingke888.com | `nginx-meeaws.xingke888.com.conf` |
| sd.xingke888.com | `nginx-sd.xingke888.com.conf` |
| v.xingke888.com | `nginx-v.xingke888.com.conf` |
| demo1.fidelityai.net | `nginx-demo1.fidelityai.net.conf` |

- `location /api/` → `http://127.0.0.1:8112/`
- `location /uploads/` → `http://127.0.0.1:8112/uploads/`
- `location /` → `http://127.0.0.1:8113`

Cloudflare 代理在前,SSL 为 Full(非严格)模式,源站的三个 xingke888 域名共用 `/etc/letsencrypt/live/sd.xingke888.com/` 证书。
`demo1.fidelityai.net` 例外 —— DNS 直连源站没走 Cloudflare,有自己的 Let's Encrypt 证书
(`/etc/letsencrypt/live/demo1.fidelityai.net/`),80 端口 301 跳 https。它和 v 一样带 `location /webhooks/`。
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
