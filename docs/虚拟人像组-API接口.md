# 虚拟人像组（/assets/virtual）调用的 API 接口

> 核查日期：2026-09-02。代码位置：
> - 前端页面 `frontend/app/assets/virtual/page.tsx` → 共享组件 `frontend/app/assets/AssetsPanel.tsx`（`tab="virtual"`）
> - 后端路由 `backend/src/routes/assets.js`（`app.register(assetRoutes, { prefix: '/assets' })`）

## 一句话结论

虚拟人像组 = **`groupType=AIGC` 的资产组**。前端只调本站后端的 `/assets/*` 路由；
后端再按 `region` 转发到火山方舟（Ark）的资产管理 OpenAPI：

| region | 上游 | 鉴权 |
|---|---|---|
| `cn`（**页面默认**） | `https://assets-cn.fidelityai.cn/?Action=<X>&Version=2024-01-01`（env `FIDELITY_CN_ASSETS_URL`） | `Authorization: Bearer $FIDELITY_CN_API_SK` |
| `global` | `https://ark.cn-beijing.volcengineapi.com/?Action=<X>&Version=2024-01-01` | 火山 AKSK V4 签名（`VOLC_ACCESS_KEY` / `VOLC_SECRET_KEY`，`lib/volcSign.js`） |

选择器：`getAssetFetcher(region)` → `assetFetchCN`（cn） / `assetFetch`→`arkCall`（global）。
`AssetsPanel.tsx` 里 `const [assetRegion, setAssetRegion] = useState<'global'|'cn'>('cn')`，
所以虚拟人像组**默认走国内站 `assets-cn.fidelityai.cn`**（页面上有 global/cn 下拉可切）。
关键常量：`groupType = tab === 'real' ? 'LivenessFace' : 'AIGC'`（AssetsPanel.tsx:108）。

## 前端 → 本站后端（都带 `?region=cn|global`）

| 动作 | 前端调用 | 后端路由 |
|---|---|---|
| 加载分组列表 | `GET /api/assets/groups?groupType=AIGC&region=<r>` | `GET /assets/groups` |
| 加载组内资产 | `GET /api/assets/groups/:groupId/assets?region=<r>` | `GET /assets/groups/:groupId/assets` |
| 补图片详情/缩略图 | `GET /api/assets/item/:assetId?region=<r>` | `GET /assets/item/:assetId` |
| 创建虚拟人像组 | `POST /api/assets/groups` body `{name, groupType:'AIGC', region}` | `POST /assets/groups` |
| 删除组 | `DELETE /api/assets/groups/:groupId?region=<r>` | `DELETE /assets/groups/:groupId` |
| 删除单个资产 | `DELETE /api/assets/item/:assetId?region=<r>` | `DELETE /assets/item/:assetId` |
| 上传图片文件 | `POST /api/upload`（本站 `/upload`，落 `backend/uploads/`） | `/upload` |
| 上传后入库为资产 | `POST /api/assets/groups/:groupId/assets` body `{fileUrl, assetType:'Image', name, region}` | `POST /assets/groups/:groupId/assets` |
| AI 创作人像 | `POST /api/voiceover/ai-image` | `/voiceover/ai-image` |

（`GET /assets/groups` 在 `region=cn` 时会先向上游 `ListAssetGroups` 同步一次，
再从本地表 `user_asset_groups` 按 `user_id`/`shared` 过滤返回。真人组专用的
`/assets/visual-validate*` 一系列接口虚拟组**不用**。）

## 后端 → 上游 Ark 资产 OpenAPI（Action 名）

`Version=2024-01-01`，POST JSON。虚拟人像组用到的 Action：

| Action | 请求体 | 触发点 |
|---|---|---|
| `ListAssetGroups` | `{PageNumber:1, PageSize:100, Filter:{GroupType:'AIGC'}}` | 列表页加载（仅 cn 同步分支） |
| `CreateAssetGroup` | `{GroupType:'AIGC', Name, Description?}` | 创建虚拟人像组 |
| `UpdateAssetGroup` | `{Id, Name}` | 重命名组 |
| `DeleteAssetGroup` | `{Id}` | 删除组（远端 404 容忍，本地表照删） |
| `ListAssets` | `{PageNumber:1, PageSize:100, Filter:{GroupIds:[groupId]}}` | 展开组 / `GET /assets/all` 选择器 |
| `GetAsset` | `{Id}` | 取单个资产 URL、缩略图、状态 |
| `CreateAsset` | `{GroupId, AssetType:'Image', URL: fileUrl, Name?}` | 上传/AI 生成后入库 |
| `UpdateAsset` | `{Id, Name}` | 重命名资产 |
| `DeleteAsset` | `{Id}` | 删除资产 |

响应统一取 `json.Result`（没有 `Result` 时取整个 body）。

## 「AI 创作」那条独立链路

`POST /api/voiceover/ai-image` → 后端走 **OpenAI 兼容的 chat/completions**：
`POST https://tokens.fidelityai.net/v1/chat/completions`（env `GEMINI_IMAGE_BASE_URL`），
model `gemini-3.1-flash-image-preview`（env `GEMINI_IMAGE_MODEL`），
`modalities: ['text','image']`，`Authorization: Bearer $GEMINI_IMAGE_API_KEY|GEMINI_API_KEY`，超时 120s。
生成的图再走 `POST /api/upload` 转存本站，最后 `CreateAsset` 入组。

## 实测

```
POST https://assets-cn.fidelityai.cn/?Action=ListAssetGroups&Version=2024-01-01
Authorization: Bearer $FIDELITY_CN_API_SK
{"PageNumber":1,"PageSize":3,"Filter":{"GroupType":"AIGC"}}
→ 200，Result.TotalCount=2，ResponseMetadata.Service=ark, Region=ap-southeast-1
```

即国内站 `assets-cn.fidelityai.cn` 是方舟资产 API 的一层代理（Service 仍报 `ark`）。
