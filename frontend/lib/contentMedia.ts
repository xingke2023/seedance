// content 里那一串 image_url / video_url / audio_url，**唯一的一份**。
// 提交、「查看提交 JSON」、参数面板的 JSON 预览、提示词里的 @图片N 编号全从这里出 ——
// 以前是四处各拼各的，排法一旦有出入（曾经参数面板把 asset 图排到上传图前面），
// 角色就锚到别人的图上了。
//
// content 里有 text / image_url / video_url / audio_url 四种块，**text 不参与编号**：
// @图片N 数的是第 N 个 image_url，@视频N / @音频N 同理，三类各自从 1 开始。
//
// 排法（**不能重排**，编号就是它）：带图角色的头像在前（换头像选的真人/虚拟头像是
// `asset-2026…` 这种 Asset ID，写成 `asset://<id>`；自己传的图就是 URL），
// 然后是「参考素材」里已就绪的素材，按上传/入列顺序，图片/视频/音频混在一起 ——
// 编号时各数各的类型。同一张图既是角色头像又被加进参考素材时只留前面那条：
// 重复一条既白占 9 张图的额度，又让后面所有编号错位。

// 结构化取字段，页面里的 ProjectSubject / MediaItem 都能直接喂进来
export type SubjectLike = { id: string; label?: string; image_url?: string | null; asset_id?: string | null };
export type MediaLike   = { url?: string; mediaType?: 'image' | 'video' | 'audio'; uploading?: boolean; name?: string; description?: string };

export type ContentMediaItem = {
  mediaType: 'image' | 'video' | 'audio';
  url: string;
  from: 'subject' | 'media';
  subjectId?: string;      // from==='subject' 时是这张图属于哪个角色
  assetId?: string;        // 头像走 Asset ID 时记下来，便于反查「角色 ↔ asset」
  name?: string;
  description?: string;
};

// 角色头像在 content 里的地址：绑了 Asset ID 就用 asset:// 引用，否则用图片 URL
export function subjectMediaUrl(s: SubjectLike): string {
  return s.asset_id ? `asset://${s.asset_id}` : (s.image_url || '');
}

// 参考素材里的 asset 引用有个历史写法 asset://remote:<id>，归一成 asset://<id>
export const normalizeAssetUrl = (u: string) =>
  u.startsWith('asset://remote:') ? u.replace('asset://remote:', 'asset://') : u;

export function buildContentMedia(videoSubjects: SubjectLike[], mediaItems: MediaLike[]): ContentMediaItem[] {
  const out: ContentMediaItem[] = [];
  const seen = new Set<string>();
  videoSubjects.filter(s => s.image_url).forEach(s => {
    const url = subjectMediaUrl(s);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ mediaType: 'image', url, from: 'subject', subjectId: s.id, assetId: s.asset_id || undefined, name: s.label });
  });
  mediaItems.filter(m => m.url && !m.uploading).forEach(m => {
    const url = normalizeAssetUrl(m.url!);
    if (seen.has(url)) return;                       // 已经作为角色头像进过 content
    seen.add(url);
    out.push({ mediaType: m.mediaType || 'image', url, from: 'media', name: m.name, description: m.description });
  });
  return out;
}

// content 里第几个同类型素材 —— 提示词里的 @图片N / @视频N / @音频N 就是这个 N
export function mediaNoOf(list: ContentMediaItem[], item: ContentMediaItem): number {
  return list.filter(x => x.mediaType === item.mediaType).indexOf(item) + 1;
}

// 角色 → 它的头像是 content 里第几张图（0 = 这个角色没有图）
export function subjectImageNo(list: ContentMediaItem[], subjectId: string): number {
  const it = list.find(x => x.from === 'subject' && x.subjectId === subjectId);
  return it ? mediaNoOf(list, it) : 0;
}
