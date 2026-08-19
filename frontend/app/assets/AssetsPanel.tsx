'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import styles from './page.module.css';

const AI_CREATE_PROMPTS: Record<string, string[]> = {
  '写实人物': [
    '年轻女性，长发披肩，职业装，自信微笑',
    '中年男性，短发，休闲风，温和表情',
    '成熟男性，西装革履，商务精英气质',
    '商务女性，短发干练，眼镜，笔记本电脑',
    '阳光大男孩，白T恤牛仔裤，灿烂笑容',
    '韩系甜美女生，空气刘海，针织衫，奶茶色',
    '运动少年，短袖T恤，阳光帅气',
    '旗袍女子，民国风，波浪短发，手持折扇',
    '温柔妈妈，围裙，厨房背景，慈祥笑容',
    '健身教练，紧身运动衣，肌肉线条，健身房',
  ],
  '动漫二次元': [
    '日系动漫少女，大眼睛，粉色短发，水手服',
    '二次元男生，银色刺猬头，学院风外套',
    '魔法少女，星星法杖，紫色长裙，闪亮翅膀',
    '哥特风少女，黑色蕾丝裙，蔷薇花，暗色调',
    '可爱猫娘，猫耳朵，尾巴，女仆装',
    '忍者少年，面具，暗色忍者服，手里剑',
    '精灵公主，尖耳朵，花环头饰，森林绿裙',
    '热血少年，红色披风，燃烧拳头，战斗姿态',
    '治愈系少女，淡绿长发，白裙，花田背景',
    '机甲驾驶员，紧身战斗服，全息面罩',
  ],
  '卡通Q版': [
    'Q版小女孩，大头，腮红，背书包',
    '卡通熊猫角色，圆滚滚，竹叶帽子',
    '像素风小人，复古游戏风格，冒险者装扮',
    '机器人管家，圆脸，蝴蝶结，银色外壳',
    'Q版古装小公主，丸子头，粉色汉服',
    '圆滚滚小柴犬，穿围裙，厨师帽',
    'Q版宇航员，大头盔，星星贴纸，可爱比心',
    '卡通独角兽，彩虹鬃毛，闪亮大眼',
    '迷你小精灵，蘑菇帽子，坐在花朵上',
    'Q版超级英雄，迷你斗篷，胖嘟嘟拳头',
  ],
};

const AI_EDIT_PROMPTS: Record<string, string[]> = {
  '背景': ['换成纯白背景', '换成蓝色渐变背景', '换成户外自然背景', '换成办公室背景', '换成夜景城市背景'],
  '服装': ['换成正式西装', '换成休闲T恤', '换成运动装', '换成古装', '换成制服'],
  '表情': ['换成微笑表情', '换成严肃表情', '换成开心大笑', '换成冷酷表情', '换成温柔表情'],
  '风格': ['变成油画风格', '变成水彩画风格', '变成赛博朋克风', '变成复古胶片风', '变成极简扁平风'],
};

interface AssetGroup {
  Id: string;
  Name: string | null;
  ProjectName: string;
  CreateTime: number;
  GroupType: 'AIGC' | 'LivenessFace';
  Region?: 'global' | 'cn';
}

interface Asset {
  Id: string;
  Name: string | null;
  AssetType: string;
  Status: string;
  PreviewUrl?: string;
  URL?: string;
  FileUrl?: string;
  GroupId?: string;
  CreateTime?: number;
  _thumbnail_url?: string;
}

export type AssetTab = 'real' | 'virtual';

export function AssetsPanel({ tab }: { tab: AssetTab }) {
  const [groups, setGroups] = useState<AssetGroup[]>([]);
  const [assets, setAssets] = useState<Record<string, Asset[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [newGroupName, setNewGroupName] = useState('');
  const [creating, setCreating] = useState(false);

  const [validateSession, setValidateSession] = useState<{ sessionId: string; h5Link: string } | null>(null);
  const [validatePolling, setValidatePolling] = useState(false);
  const [validateRegion, setValidateRegion] = useState<'global' | 'cn'>('cn');
  const [assetRegion, setAssetRegion] = useState<'global' | 'cn'>('cn');

  // AI创作 state
  const [showAiChat, setShowAiChat] = useState(false);
  const [aiGroupId, setAiGroupId] = useState<string | null>(null);
  const [aiTurns, setAiTurns] = useState<Array<{ id: number; role: 'user' | 'assistant'; text?: string; image?: string; description?: string; refPreviews?: string[]; loading?: boolean; error?: string }>>([]);
  const [aiInput, setAiInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiLastImage, setAiLastImage] = useState<string | null>(null);
  const [aiRefImages, setAiRefImages] = useState<Array<{ file: File; preview: string }>>([]);
  const [showAiPrompts, setShowAiPrompts] = useState(false);
  const [aiPromptSeed, setAiPromptSeed] = useState(0);
  const [aiPromptTab, setAiPromptTab] = useState('');
  const [aiUploading, setAiUploading] = useState(false);
  const aiBottomRef = useRef<HTMLDivElement>(null);
  const aiFileRef = useRef<HTMLInputElement>(null);
  const aiIdRef = useRef(0);

  const groupType = tab === 'real' ? 'LivenessFace' : 'AIGC';
  const currentRegion = tab === 'virtual' ? assetRegion : validateRegion;

  const loadGroups = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<{ Items: AssetGroup[]; TotalCount: number }>(`/assets/groups?groupType=${groupType}&region=${currentRegion}`);
      const items = res.Items || [];
      setGroups(items);
      setExpandedGroups(new Set(items.map(g => g.Id)));
      items.forEach(g => loadAssets(g.Id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [groupType, currentRegion]);

  useEffect(() => { loadGroups(); }, [loadGroups]);

  async function loadAssets(groupId: string) {
    try {
      const res = await api.get<{ Items: Asset[] }>(`/assets/groups/${groupId}/assets?region=${currentRegion}`);
      const items = res.Items || [];
      const enriched = await Promise.all(items.map(async (item) => {
        if (item._thumbnail_url) {
          return { ...item, Status: item.Status || 'Active' };
        }
        if (item.AssetType === 'Image') {
          try {
            const detail = await api.get<{ URL?: string; Status?: string; _thumbnail_url?: string }>(`/assets/item/${item.Id}?region=${currentRegion}`);
            return { ...item, URL: detail.URL || undefined, _thumbnail_url: detail._thumbnail_url || undefined, Status: detail.Status || item.Status };
          } catch { return item; }
        }
        return item;
      }));
      setAssets(prev => ({ ...prev, [groupId]: enriched }));
    } catch {}
  }

  function toggleGroup(groupId: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
        if (!assets[groupId]) loadAssets(groupId);
      }
      return next;
    });
  }

  async function createGroup() {
    if (!newGroupName.trim() && tab === 'virtual') return;
    setCreating(true);
    try {
      if (tab === 'virtual') {
        await api.post('/assets/groups', { name: newGroupName.trim(), groupType: 'AIGC', region: assetRegion });
        setNewGroupName('');
        await loadGroups();
      } else {
        const endpoint = validateRegion === 'cn' ? '/assets/visual-validate-cn/start' : '/assets/visual-validate/start';
        const res = await api.post<{ session_id: string; h5_link: string }>(endpoint);
        setValidateSession({ sessionId: res.session_id, h5Link: res.h5_link });
        setValidatePolling(true);
        pollValidate(res.session_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  }

  async function pollValidate(sessionId: string) {
    const endpoint = validateRegion === 'cn' ? '/assets/visual-validate-cn' : '/assets/visual-validate';
    const interval = setInterval(async () => {
      try {
        const res = await api.get<{ status: string; group_id?: string }>(`${endpoint}/${sessionId}`);
        if (res.group_id || res.status === 'completed' || res.status === 'succeeded') {
          clearInterval(interval);
          setValidateSession(null);
          setValidatePolling(false);
          await loadGroups();
        } else if (res.status === 'failed' || res.status === 'expired') {
          clearInterval(interval);
          setValidateSession(null);
          setValidatePolling(false);
          setError('验证失败或超时，请重试');
        }
      } catch {
        clearInterval(interval);
        setValidatePolling(false);
      }
    }, 3000);
  }

  async function deleteGroup(groupId: string) {
    if (!confirm('确定删除该资源组？组内所有资源将被删除。')) return;
    try {
      await api.del(`/assets/groups/${groupId}?region=${currentRegion}`);
      await loadGroups();
    } catch {}
  }

  async function deleteAsset(assetId: string, groupId: string) {
    if (!confirm('确定删除该资源？')) return;
    try {
      await api.del(`/assets/item/${assetId}?region=${currentRegion}`);
      await loadAssets(groupId);
    } catch {}
  }

  async function uploadAssetToGroup(groupId: string, file: File) {
    const form = new FormData();
    form.append('file', file);
    try {
      const { getAccessToken } = await import('@/lib/auth');
      const headers: Record<string, string> = {};
      const token = getAccessToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: form, headers });
      const uploadJson = await uploadRes.json();
      if (!uploadJson.success) throw new Error(uploadJson.error);

      const fileUrl = uploadJson.data.url;
      const assetType = file.type.startsWith('video/') ? 'Video'
                      : file.type.startsWith('audio/') ? 'Audio'
                      : 'Image';

      await api.post(`/assets/groups/${groupId}/assets`, {
        fileUrl,
        assetType,
        name: file.name,
        region: currentRegion,
      });
      await loadAssets(groupId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    }
  }

  // AI创作 functions
  useEffect(() => { aiBottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [aiTurns]);

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function aiSend(text: string) {
    const trimmed = text.trim();
    if (!trimmed || aiBusy) return;
    const userId = ++aiIdRef.current;
    const assistantId = ++aiIdRef.current;
    const refPreviews = aiRefImages.map(r => r.preview);
    setAiTurns(prev => [...prev, { id: userId, role: 'user', text: trimmed, refPreviews: refPreviews.length > 0 ? refPreviews : undefined }, { id: assistantId, role: 'assistant', loading: true }]);
    setAiInput('');
    setAiBusy(true);
    const currentRefImages = [...aiRefImages];
    setAiRefImages([]);
    try {
      const { getAccessToken } = await import('@/lib/auth');
      const token = getAccessToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const body: Record<string, unknown> = { prompt: trimmed };
      if (aiLastImage) {
        const m = aiLastImage.match(/^data:([^;]+);base64,(.*)$/);
        if (m) body.priorImage = { mimeType: m[1], data: m[2] };
        else body.priorImageUrl = aiLastImage;
      }
      if (currentRefImages.length > 0) {
        const refImgs: Array<{ mimeType: string; data: string }> = [];
        for (const item of currentRefImages) {
          const dataUrl = await fileToBase64(item.file);
          const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
          if (match) refImgs.push({ mimeType: match[1], data: match[2] });
        }
        if (refImgs.length > 0) body.referenceImages = refImgs;
      }
      const res = await fetch('/api/voiceover/ai-image', { method: 'POST', headers, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || '生成失败');
      const image = json.data.image;
      const aiDesc = json.data.description || '';
      setAiLastImage(image);
      setAiTurns(prev => prev.map(t => t.id === assistantId ? { ...t, loading: false, image, description: aiDesc } : t));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '生成失败，请重试';
      setAiTurns(prev => prev.map(t => t.id === assistantId ? { ...t, loading: false, error: msg } : t));
    } finally {
      setAiBusy(false);
    }
  }

  async function aiUseImage(imageUrl: string) {
    if (!aiGroupId) return;
    setAiUploading(true);
    try {
      const { getAccessToken } = await import('@/lib/auth');
      const token = getAccessToken();
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const resp = await fetch(imageUrl);
      const blob = await resp.blob();
      const form = new FormData();
      form.append('file', new File([blob], 'ai-creation.png', { type: 'image/png' }));

      const uploadRes = await fetch('/api/upload', { method: 'POST', body: form, headers });
      const uploadJson = await uploadRes.json();
      if (!uploadJson.success) throw new Error(uploadJson.error);

      await api.post(`/assets/groups/${aiGroupId}/assets`, {
        fileUrl: uploadJson.data.url,
        assetType: 'Image',
        name: 'AI创作',
      });
      await loadAssets(aiGroupId);
      setShowAiChat(false);
      setAiGroupId(null);
      setAiTurns([]);
      setAiLastImage(null);
      setAiRefImages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setAiUploading(false);
    }
  }

  function openAiChat(groupId: string) {
    setAiGroupId(groupId);
    setShowAiChat(true);
    setAiTurns([]);
    setAiLastImage(null);
    setAiInput('');
    setAiRefImages([]);
    setShowAiPrompts(false);
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.desc}>
          {tab === 'virtual' ? (
            <>
              <p>虚拟人像资源，无需活体验证，直接创建组并上传素材。</p>
              <p className={styles.warn}>上传素材必须合法拥有使用权，不得与真实人物肖像相似。</p>
            </>
          ) : (
            <>
              <p>真人资源需要通过 H5 活体验证（人脸识别）创建资源组。</p>
              <p>验证通过后可在组内上传图片/视频/音频，生成视频时通过 <code>asset://</code> 引用。</p>
            </>
          )}
        </div>

        <div className={styles.createRow}>
          {tab === 'virtual' && (
            <>
              <select value={assetRegion} onChange={e => setAssetRegion(e.target.value as 'global' | 'cn')}
                className={styles.input} style={{ width: 'auto', minWidth: 100 }}>
                <option value="cn">国内站</option>
                <option value="global">国际站</option>
              </select>
              <input type="text" placeholder="资源组名称" value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)} className={styles.input} />
            </>
          )}
          {tab === 'real' && (
            <select value={validateRegion} onChange={e => setValidateRegion(e.target.value as 'global' | 'cn')}
              className={styles.input} style={{ width: 'auto', minWidth: 100 }}>
              <option value="cn">国内站</option>
              <option value="global">国际站</option>
            </select>
          )}
          <button onClick={createGroup} disabled={creating || (tab === 'virtual' && !newGroupName.trim())}
            className={styles.btnPrimary}>
            {creating ? '创建中...' : tab === 'virtual' ? '创建虚拟人像组' : '添加真人（H5 验证）'}
          </button>
          <button onClick={loadGroups} disabled={loading} className={styles.btnGhost}>刷新</button>
        </div>

        {validateSession && (
          <div className={styles.validateBox}>
            <h3>真人验证</h3>
            <p>请在手机端完成活体验证：</p>
            <div className={styles.qrWrap}>
              <img src={`/api/assets/visual-validate${validateRegion === 'cn' ? '-cn' : ''}/${validateSession.sessionId}/qr`} alt="扫码验证" />
            </div>
            <a href={validateSession.h5Link} target="_blank" rel="noopener noreferrer" className={styles.btnGhost}>
              在当前设备打开验证
            </a>
            {validatePolling && <p className={styles.polling}>等待验证完成...</p>}
          </div>
        )}

        {error && <div className={styles.errorBox}>{error}</div>}

        {loading && groups.length === 0 && <p className={styles.muted}>加载中...</p>}

        <div className={styles.groupList}>
          {groups.map((group, index) => (
            <div key={group.Id} className={styles.groupCard}>
              <div className={styles.groupHead} onClick={() => toggleGroup(group.Id)}>
                <div className={styles.groupInfo}>
                  <span className={styles.groupName}>{group.Name || group.Id}</span>
                  <span className={styles.groupNameMobile}>{group.Name || `${tab === 'real' ? '真人头像' : '虚拟人像'}组${index + 1}`}</span>
                  {group.Name && <span className={styles.groupId}>{group.Id}</span>}
                  <span className={styles.groupTime}>
                    {new Date(group.CreateTime * 1000).toLocaleDateString('zh-CN')}
                  </span>
                </div>
                <div className={styles.groupActions}>
                  <label className={styles.uploadBtn} onClick={e => e.stopPropagation()}>
                    上传素材
                    <input type="file" accept="image/*,video/*,audio/*" style={{ display: 'none' }}
                      onChange={e => { const f = e.target.files?.[0]; if (f) uploadAssetToGroup(group.Id, f); e.target.value = ''; }} />
                  </label>
                  {tab === 'virtual' && (
                    <button className={styles.aiCreateBtn} onClick={e => { e.stopPropagation(); openAiChat(group.Id); }}>
                      AI创作
                    </button>
                  )}
                  <button onClick={e => { e.stopPropagation(); deleteGroup(group.Id); }}
                    className={styles.btnClose}>×</button>
                </div>
              </div>

              {expandedGroups.has(group.Id) && (
                <div className={styles.groupBody}>
                  {(assets[group.Id] || []).length === 0 && (
                    <p className={styles.muted}>暂无资源</p>
                  )}

                  <div className={styles.assetGrid}>
                    {(assets[group.Id] || []).map(asset => (
                      <div key={asset.Id} className={styles.assetCard}>
                        {asset.AssetType === 'Image' && (asset.URL || asset._thumbnail_url || asset.PreviewUrl) && (
                          <img src={asset._thumbnail_url || asset.URL || asset.PreviewUrl} alt="" className={styles.assetThumb} />
                        )}
                        <div className={styles.assetInfo}>
                          <span className={styles.assetType}>{asset.AssetType} · {asset.Status}</span>
                          <code className={styles.assetUri}>asset://{asset.Id}</code>
                        </div>
                        <button onClick={() => deleteAsset(asset.Id, group.Id)}
                          className={styles.btnDangerSm}>x</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}

          {!loading && groups.length === 0 && (
            <p className={styles.muted}>暂无资源组，点击上方按钮创建</p>
          )}
        </div>

        {showAiChat && (
          <div className={styles.aiOverlay} onClick={() => setShowAiChat(false)}>
            <div className={styles.aiModal} onClick={e => e.stopPropagation()}>
              <div className={styles.aiHeader}>
                <span className={styles.aiTitle}>AI创作角色</span>
                <div className={styles.aiHeaderRight}>
                  {aiTurns.length > 0 && (
                    <button className={styles.aiClearBtn} onClick={() => { setAiTurns([]); setAiLastImage(null); setAiRefImages([]); }}>清空对话</button>
                  )}
                  <button className={styles.aiClose} onClick={() => setShowAiChat(false)}>×</button>
                </div>
              </div>
              <div className={styles.aiBody}>
                {aiTurns.length === 0 ? (
                  <div className={styles.aiEmpty}>
                    <div style={{ fontSize: 32, opacity: 0.3, marginBottom: 8 }}>🎨</div>
                    描述你想要的角色形象，AI会为你生成图片。<br/>生成后可继续修改（换服装/改发型/调风格）。<br/>点击「使用此图片」直接上传到当前资源组。
                  </div>
                ) : (
                  aiTurns.map(t => (
                    <div key={t.id} className={t.role === 'user' ? styles.aiMsgUser : styles.aiMsgBot}>
                      {t.role === 'user' ? (
                        <div className={styles.aiBubbleUser}>
                          {t.text}
                          {t.refPreviews && t.refPreviews.length > 0 && (
                            <div className={styles.aiMsgRefRow}>
                              {t.refPreviews.map((src, i) => (
                                <img key={i} src={src} alt="" className={styles.aiMsgRefThumb} />
                              ))}
                            </div>
                          )}
                        </div>
                      ) : t.loading ? (
                        <div className={styles.aiBubbleBot}>正在生成图片，请稍候…</div>
                      ) : t.error ? (
                        <div className={styles.aiBubbleBotErr}>{t.error}</div>
                      ) : (
                        <div className={styles.aiBubbleBotImg}>
                          <img src={t.image} alt="生成结果" className={styles.aiGenImg} />
                          <button className={styles.aiUseBtn} onClick={() => aiUseImage(t.image!)} disabled={aiUploading}>
                            {aiUploading ? '正在处理中，请耐心等待…' : '使用此图片'}
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
                <div ref={aiBottomRef} />
              </div>
              <div className={styles.aiChips}>
                {showAiPrompts && (
                  <div className={styles.aiPromptPanel}>
                    <div className={styles.aiPromptTabs}>
                      {Object.keys(aiLastImage ? AI_EDIT_PROMPTS : AI_CREATE_PROMPTS).map(cat => (
                        <button key={cat} className={`${styles.aiPromptTabBtn} ${aiPromptTab === cat ? styles.aiPromptTabActive : ''}`} onClick={() => setAiPromptTab(cat)}>{cat}</button>
                      ))}
                    </div>
                    <div className={styles.aiPromptList}>
                      {(() => {
                        const source = aiLastImage ? AI_EDIT_PROMPTS : AI_CREATE_PROMPTS;
                        const arr = aiPromptTab && source[aiPromptTab] ? [...source[aiPromptTab]] : Object.values(source).flat();
                        for (let i = arr.length - 1; i > 0; i--) { const j = (i * (aiPromptSeed + 1) * 7 + 13) % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
                        return arr.slice(0, 12);
                      })().map(p => (
                        <button key={p} className={styles.aiChip} onClick={() => { setAiInput(p); setShowAiPrompts(false); }}>{p}</button>
                      ))}
                    </div>
                    <button className={styles.aiRefreshBtn} onClick={() => setAiPromptSeed(v => v + 1)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
                      换一批
                    </button>
                  </div>
                )}
                <button className={styles.aiPromptToggle} onClick={() => setShowAiPrompts(v => !v)} title="提示词">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showAiPrompts ? 'rotate(180deg)' : 'none' }}><polyline points="18 15 12 9 6 15"/></svg>
                  <span>提示词</span>
                </button>
              </div>
              <div className={styles.aiInputRow}>
                <label className={styles.aiAttachBtn} title="上传参考图">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                  <input ref={aiFileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => {
                    const files = Array.from(e.target.files || []);
                    const newItems = files.map(f => ({ file: f, preview: URL.createObjectURL(f) }));
                    setAiRefImages(prev => [...prev, ...newItems].slice(0, 5));
                    e.target.value = '';
                  }} />
                </label>
                <textarea
                  className={styles.aiTextarea}
                  rows={2}
                  value={aiInput}
                  onChange={e => setAiInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(aiInput); } }}
                  disabled={aiBusy}
                  placeholder={aiLastImage ? '继续修改，如「换成蓝色背景」…' : '描述你想要的角色形象…'}
                />
                <button className={styles.aiSendBtn} onClick={() => aiSend(aiInput)} disabled={aiBusy || !aiInput.trim()}>
                  {aiBusy ? '生成中…' : '发送'}
                </button>
              </div>
              {aiRefImages.length > 0 && (
                <div className={styles.aiRefRow}>
                  {aiRefImages.map((item, i) => (
                    <div key={i} className={styles.aiRefThumb}>
                      <img src={item.preview} alt="" />
                      <button className={styles.aiRefRemove} onClick={() => setAiRefImages(prev => prev.filter((_, idx) => idx !== i))}>×</button>
                    </div>
                  ))}
                  <span className={styles.aiRefHint}>参考图 {aiRefImages.length}/5</span>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

