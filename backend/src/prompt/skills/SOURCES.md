# 技能库：出处与取舍

这个目录是**分镜提示词的手艺层**。系统提示词（`../prompts.js`）管叙事框架和 JSON 输出结构，
skill 管「一个镜头到底怎么写成 prompt_en」。

**按情况自动选用**：`index.js` 从一次分镜请求归纳出上下文（视频类型、叙事结构、画幅、镜头数、
总时长、有没有绑角色、有没有参考视频音频、有没有对白），逐条比对 skill 的 `when_*` 条件，
命中的按 `priority` 拼在 user message 末尾。调用方（voiceover-v3 的「生成分镜脚本」）
不需要知道有哪些手艺 —— 它只管把参数发过来。

`GET /prompt/skills` 列出全部；带上与 `/prompt/storyboard` 同名的 query 可以预览某组情况会装哪几条。
`POST /prompt/storyboard` 的返回里也带 `skills: []`，是这次实际装载的清单。

## 当前技能库

| priority | skill | 生效条件 | 内容 |
|---|---|---|---|
| 10 | `seedance-2-0-prompting` | 始终 | 开场格式声明、五段结构、身份逐镜重写 + 锁定短语、`@图片N`/`@视频N`/`@音频N` 引用、**主体定义句式**、**重要素材前置**、**多图指代同一主体**、时间轴节拍、状态单调、运镜原语、否定式镜头控制、反主观规则、声音块、长度与忌讳 |
| 11 | `style-lock` | 始终 | 每镜都要写风格约束词、风格词要指名道姓、写实参考图配非写实目标风格最易漂、风格词只留一套 |
| 14 | `default-guardrails` | 始终 | 画质包 + 稳定包必挂、多人场景挂双胞胎兜底、多人正面动态加强方位约束 |
| 12 | `subtitle-safe-area` | 始终 | 下三分之一留位（英文写法钉死为 kept clean and unobstructed）、**提示词里不许出现 subtitle/caption**、每镜必带 `no subtitles, no captions, no on-screen text` 否定串、画面里不要出现要看清的文字 |
| 13 | `in-video-slogan` | `has_slogan=true` | 广告语四段模板（内容+时机+位置+方式+文字特征）、只写在指定那一镜、避开下三分之一 |
| 15 | `hook-and-retention` | 始终 | 四种钩子选一、前两镜交代清楚、but-therefore 衔接、误解优先、揭示后静默、结尾呼应开头 |
| 20 | `story-dialogue` | `video_type=story` | 2/3 镜头有人开口、画面描述里不写具体台词、两人对话排镜、进出画四原语、时长呼吸、一画面最多两张脸 |
| 25 | `character-anchoring` | `has_subjects=true` | **逐镜先定义主体再用标签指代**、跨镜同一套定义文字、编号不串、一角色多图要写清分工、多角色分别定义、角色引用往前放、锁定短语堆叠、换装写法、脸要拍得够大、同框不超两张脸 |
| 26 | `reference-media` | `has_reference_media=true` | `@视频N` 学运镜还是学动作要写清、持续肢体接触挂动作参考、`@音频N` 当环境声底子、**`@音频N` + 中文音色描述克隆音色** |
| 30 | `broll-craft` | `video_type=story` | 情绪优先于字面、抽象概念落到实物、A/B-roll 判定 |
| 30 | `narration-broll` | `video_type=narration` | 声画 2:6:2、闭眼自检、堪景式写法、一镜一个有效瞬间、镜内变化、语速浮动 |
| 35 | `narration-voice` | `video_type=narration` | 旁白写成能念的口语、用停顿做结构、一镜一种情绪、禁止空泛表演指令、数字写成念得出的形式 |
| 36 | `narration-voice-style` | `video_type=narration` | 逐镜 `voice_style`（calm/serious/worried/warm/uplifting），跟着全片情绪弧走、一镜一种情绪、不在两极之间跳 |
| 40 | `vertical-short-form` | `ratio=9:16/3:4` | 首镜 `0-1s` 就要有动作、竖幅构图词、单镜 ≤8 秒、竖向纵深、总时长 15-30 秒 |
| 40 | `cinematic-widescreen` | `ratio=21:9/16:9/4:3` | 镜头时长呼吸（同一时长不连排 3 次）、切点按情绪排、全片一套色调、暗部高光处理、横向分层 |
| 90 | `roll-type-field` | 始终 | 追加 `roll_type` 字段 |

## 上游

> 完整的官方优化器规范存放在 `/home/ubuntu/doc/SKILL_Seedance2.0.md`。

参考项目 **OpenMontage**（`/home/ubuntu/OpenMontage`，agentic 视频生产系统）。本项目的视频
**全部由 Seedance 2.0 生成**，取舍的唯一标准是：这条手艺对 Seedance 2.0 的单条生成有没有用。

| 本目录 | 上游 |
|---|---|
| `seedance-2-0-prompting` | `.agents/skills/seedance-2-0/SKILL.md`（Layer 3 权威，Higgsfield 方法论）、`skills/creative/prompting/seedance-prompting.md`、`skills/creative/video-gen-prompting.md`；状态单调与「禁止要给替代」借自 `seedance-2-5/SKILL.md` |
| `story-dialogue` / `character-anchoring` / `reference-media` | `seedance-2-0/SKILL.md`（lip-sync、reference-to-video、多人同框、抗漂移）+ `skills/creative/cinematic.md` + `skills/creative/storytelling.md` |
| `narration-broll` | `docs/narration-broll-pairing.md`（提炼自 `skills/creative/broll-planning.md`、`long-form.md`、`skills/pipelines/documentary-montage/*`） |
| `narration-voice` / `narration-voice-style` | `skills/meta/voice-performance-director.md`（能量曲线、一段一个情绪）；`voice_style` → Azure `mstts:express-as` 是本项目自有 |
| `hook-and-retention` | `skills/creative/storytelling.md` + `skills/creative/short-form.md` |
| `vertical-short-form` | `skills/creative/short-form.md` |
| `cinematic-widescreen` | `skills/creative/cinematic.md` |
| `broll-craft` / `subtitle-safe-area` / `roll-type-field` | 本项目自有（`subtitle-safe-area` 的英文写法钉死是踩坑后加的：不钉死模型会写成 upper third；**「别在提示词里提 subtitles」是第二次踩坑后加的** —— 原来那句 `lower third kept clean for subtitles` 反而诱导模型真渲一行字幕，和后期烧的重叠） |

另有一批规则来自**用户提供的 Seedance 2.0 官方约定与提示词指南**（不是 OpenMontage），
它们描述的是这个模型自己的接口行为，优先级高于上游的通用经验：

| 规则 | 落在哪 | 原文要点 |
|---|---|---|
| `图片N/视频N/音频N` = content 数组里第 N 个 `image_url`/`video_url`/`audio_url`（三类各自从 1 开始） | `seedance-2-0-prompting` ② | 与后端 `video/service.js` 的 content 拼装顺序一一对应 |
| **重要素材前置** | `seedance-2-0-prompting` ②、`character-anchoring` 4、`reference-media` 6 | 越需要精准参考的素材，在提示词里放得越靠前 |
| **多图指代同一主体**（`提取图片1、图片2、图片3的相机…展示正面侧面以及背面`） | `seedance-2-0-prompting` ②、`character-anchoring` 3 | 一次点全多张图会被合成同一个主体；写清每张管哪一面。主体不限于人，产品/道具同样适用，还能顺带抠出原背景重新布景 |
| **`@音频N` + 中文音色特征描述**（`使用@音频1低厚温润带细碎颗粒感中年男声的音色说…`） | `reference-media` 5 | 加音色描述后匹配度明显提升；只写编号不描述会飘 |
| **一镜一运镜**（单镜只指定 1 种运镜，禁止推拉摇移叠加） | `seedance-2-0-prompting` ④ | 叠加时模型只会跟一个，结果不可控 |
| **素材引用统一写 `@图片N` / `@视频N` / `@音频N`**，`<>` 留给音效、只有 `<主体N>` 用尖括号 | 全链路：skills、`/prompt/storyboard` 的 user message、`/voiceover/analyze-subjects` 的主体定义、前端 `subjectContext` | 旧写法 `<图片1>` 占了音效的符号位。后端提取正则改成 `[<@]?图片\s*(\d+)\s*>?`，**两种写法都认** —— 库里存量分镜用的是尖括号那套 |
| **断句防歧义**（`@图片N` 后不要紧接动词/方位词） | `seedance-2-0-prompting` ② | 数字粘连会读歧义，要补名词隔断或改用 `<主体N>` |
| **人物禁用三视图**（只用大头照 + 全身照） | `seedance-2-0-prompting` ②、`character-anchoring` 3 | 多视图触发 ID 漂移与双胞胎；「多图一次点全」只适用于物体/产品 |
| **优先低缓连续小动作**、肢体细化 + 程度量化、动作惯性衔接 | `seedance-2-0-prompting` ③ | 动作越剧烈越容易崩肢体 |
| **默认兜底包**（画质包 / 稳定包 / 双胞胎兜底 / 强方位约束） | `default-guardrails`（新增，始终装载） | 官方要求每条提示词必挂画质包 + 稳定包 |
| **台词语种统一 + 中文发音兜底**（多音字改同音字） | `DIALOGUE_SYSTEM` 9-10 | 混用语种会中途切发音；多音字/生僻字模型常读错 |
| **主体定义挑 2-3 个稳定静态特征** | `character-anchoring` 4 | 拿表情/动作/临时道具定义锚不住 |
| **多图参考**（主体多视角、场景图、服装图、分镜图、标识图；按顺序上传，`图片1..N` 准确指代） | `seedance-2-0-prompting` ② | 一镜可同时点多张、每张写清职能；编号即上传顺序不可重排；标识可钉固定位置但要避开下三分之一（留给后期字幕） |
| **风格漂移**（写实参考图 + 非写实目标风格且提示词没强调 → 漂回真人写实） | `style-lock`（新增，始终装载）、`seedance-2-0-prompting` ① | 加明确风格约束词（`2D日漫风格`/`3D国风漫画`）；更精准的做法是先把参考图转成目标风格再生视频。① 里写死的 `photorealistic, 35mm film grain` 现在标明只适用写实风格，不能和动漫风格词并存 |
| **广告语模板**（`「文字内容」+「出现时机」+「出现位置」+「出现方式」，「文字特征」`） | `in-video-slogan`（新增，`has_slogan=true` 才装） | 本项目原本禁止画面内文字（一律后期烧），这是唯一例外，所以做成条件生效而不是放开 |
| **主体定义句式**（`将 @图片1 中穿红色连衣裙、戴草帽的女人定义为 <主体1>`，也可定义为名字或身份） | `seedance-2-0-prompting` ②、`character-anchoring` 1-5 | 定义后每次提到都用同一标签；多主体分别定义、标签唯一稳定；未定义的简单场景写 `<主体N>@图片N`；**不得用 Asset ID 代替 `@图片N`**（模型关联不上）；定义要简洁不矛盾，空间关系优先靠参考图 |


`DIALOGUE_SYSTEM` 里的**音色条件句**（每个角色一句 `voice_en`，逐镜原样粘贴）来自
`seedance-2-5/SKILL.md` 的 Voice 一节 —— 与版本无关的通用规律：我们每个分镜是一次独立生成，
不锁音色，同一个角色逐镜声音都不一样。

## 与官方规范的分歧（待决策）

`/home/ubuntu/doc/SKILL_Seedance2.0.md` 里有两条和本项目现行做法冲突，**尚未改动**
（第三条「素材引用统一用 `@图片N`」已于本次采纳，见下面的采纳表）：

| 官方说法 | 我们现在 | 为什么没直接改 |
|---|---|---|
| **禁止绝对秒数**（`0–3s`），用 `镜头1/2/3` 排序 —— 「Seedance 2.0 对精确时间支持不稳定」 | `seedance-2-0-prompting` ③ 要求 `0-3s: … 3-6s: …` 的时间轴节拍 | 官方的 `镜头N` 是**一次生成多镜**的写法，本项目**一个分镜 = 一条视频**，用不了。折中方案是保留节拍但去掉数字（先…接着…最后…），需要实测对比 |
| **台词写成 `{台词}`**，音效 `<>`、BGM `（）`、字幕 `【】` | 对白块用 `X says: “台词”`（英文句式 + 中文原文） | 现行写法的口型对齐是验证过能用的（出处 OpenMontage seedance-2-0/SKILL.md）。两套约定不能混用，要改得整条链路一起改并 A/B 实测 |

另外官方规范里的**任务分类**（编辑视频 / 延长视频 / 组合任务）本项目一个都没用上 ——
我们只做「多模态参考」这一类。其中「向后延长 @视频N」有实际价值：
分镜时长不够时可以延长而不是重做，但需要新的接口和 UI，不在当前范围内。

## 刻意没照搬

| 上游说法 | 为什么不用 |
|---|---|
| 一条 prompt 里排 `Shot 1 / Shot 2` 多镜头 | 本项目**一个分镜 = 一条 Seedance 视频**，时长、字幕、合并全按分镜算。多镜头切分会让字幕对不上 |
| 单条 B-roll 5-8 秒、2.5 秒/镜的多镜节奏 | 那是实拍素材剪进连续旁白轨的节奏；我们一镜就是一条生成视频，改写成「镜头内部每 3-5 秒要有一次可见变化」 |
| 语速 4-5 字/秒 | 与 `NARRATION_SYSTEM` 的 3.5 字/秒基准冲突，改成相对浮动（钩子 4.5、洞察 3） |
| 字幕字号/描边/LUFS/混音电平等成片参数 | 由合并链路的 `subtitleStyle` 和 ffmpeg 固定流程决定，不该塞进给模型的提示词 |
| 战斗动词表、VFX 内联标记的完整用法 | 港险题材用不到；只留了慢动作标记和「动词要具体有力」 |
| `video_selector` / 多网关路由 / 成本调度 | 我们直连一个网关，没有 provider 选择问题 |
| 素材制作（角色三视图、rule of 10、实拍取景） | 角色图来自 FidelityAI 资源库，不在本项目内生产 |
| 剪辑与混音（L-cut、色彩分级、Remotion 合成） | 合并链路是 ffmpeg 固定流程，不由模型决定 |

## 加一条手艺

丢一个 `.md` 进这个目录即可，不用改代码：

```yaml
---
name: <标识>
title: <中文名>
priority: 40                   # 小的拼在前
when_video_type: story         # 条件，可多条，全部满足才装载；不写就是不限制
when_ratio: 9:16, 3:4          # 逗号分隔 = 命中其一
when_total_seconds_lte: 60     # 数值条件用 _lte / _gte
when: <人读的说明，会出现在 /prompt/skills>
source: <出处，改写时要能追回上游>
---
```

正文就是要拼进 user message 的那段中文提示词。可用的条件字段见 `index.js` 顶部注释
（`video_type` / `narrative_structure` / `ratio` / `shot_count` / `total_seconds` /
`has_subjects` / `has_reference_media` / `has_dialogue`）。上下文里没有的字段一律**不匹配** ——
宁可少装一条，也不要在信息不全时把不相干的规则塞给模型。

写完 `pm2 restart seedance20-backend`（skill 在启动时读一次 —— 热加载会让「当前跑的是哪一版」说不清）。
