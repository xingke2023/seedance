export interface Shot {
  id: string;
  video_id: string;
  shot_number: number;
  title: string | null;
  description: string | null;
  prompt: string | null;
  subtitle: string | null;
  duration: number;
  ratio: string | null;
  mood: string | null;
  shot_type: string | null;
  lighting: string | null;
  camera_movement: string | null;
  camera_position_x: number;
  camera_position_y: number;
  camera_position_z: number;
  camera_target_x: number;
  camera_target_y: number;
  camera_target_z: number;
  camera_fov: number;
  camera_movement_type: string;
  camera_movement_path: any[] | null;
  reference_images: ReferenceImage[];
  subjects: ShotSubject[];
  task_id: string | null;
  task_status: string;
  video_url: string | null;
  local_url: string | null;
  video_duration: number | null;
  task_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReferenceImage {
  url: string;
  name?: string;
  role?: string;
}

export interface PoseParams {
  leftArm?: number;
  rightArm?: number;
  leftLeg?: number;
  rightLeg?: number;
  torso?: number;
  head?: number;
}

export interface ShotSubject {
  label: string;
  assetId?: string;
  imageUrl?: string;
  position?: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale?: number;
  color?: string;
  pose?: string;
  poseParams?: PoseParams;
}

export const SUBJECT_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#f97316'];

export const POSE_PRESETS: Record<string, { label: string; params: PoseParams }> = {
  standing: { label: '站立', params: { leftArm: 5, rightArm: -5, leftLeg: 0, rightLeg: 0, torso: 0, head: 0 } },
  walking:  { label: '行走', params: { leftArm: 30, rightArm: -30, leftLeg: -20, rightLeg: 20, torso: 0, head: 0 } },
  sitting:  { label: '坐姿', params: { leftArm: -10, rightArm: -10, leftLeg: -90, rightLeg: -90, torso: -10, head: 0 } },
  waving:   { label: '举手', params: { leftArm: 5, rightArm: 160, leftLeg: 0, rightLeg: 0, torso: 0, head: 10 } },
  akimbo:   { label: '叉腰', params: { leftArm: -50, rightArm: -50, leftLeg: 0, rightLeg: 0, torso: 0, head: 0 } },
  pointing: { label: '指向', params: { leftArm: 5, rightArm: 90, leftLeg: 0, rightLeg: 0, torso: 5, head: 15 } },
};

export interface ProjectSubject {
  id: string;
  project_id: string;
  label: string;
  description: string | null;
  image_url: string | null;
  asset_id: string | null;
  action_url: string | null;
  sound_url: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Video {
  id: string;
  project_id: string;
  name: string;
  script: string | null;
  subtitle_input: string | null;
  style: string | null;
  ratio: string;
  seed: number | null;
  params: VideoParams;
  voice: string | null;
  audio_url: string | null;
  merged_video_url: string | null;
  sort_order: number;
  status: string;
  shots: Shot[];
  media_items: MediaItem[];
  created_at: string;
  updated_at: string;
}

export interface VideoParams {
  model?: string;
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  seed?: number;
  serviceTier?: string;
  priority?: string;
  returnLastFrame?: boolean;
  draft?: boolean;
  webSearch?: boolean;
}

export interface MediaItem {
  id: string;
  video_id: string;
  media_type: string;
  url: string;
  name: string | null;
  preview_url: string | null;
  sort_order: number;
}

export interface CameraState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  fov: number;
  movementType: string;
  movementPath?: any[];
}

export const MODELS = [
  { value: 'doubao-seedance-2-0-fast', label: 'Seedance 2.0 Fast' },
  { value: 'doubao-seedance-2-0', label: 'Seedance 2.0' },
];

export const RATIOS = [
  { value: '21:9', label: '21:9' },
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '3:4', label: '3:4' },
  { value: '9:16', label: '9:16' },
];

export const AZURE_VOICES = [
  { value: 'zh-CN-YunfengNeural', label: '云枫（磁性男声）' },
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓（温柔女声）' },
  { value: 'zh-CN-YunxiNeural', label: '云希（专业男声）' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓伊（活泼女声）' },
  { value: 'zh-CN-YunyangNeural', label: '云扬（新闻男声）' },
];

export const MOVEMENT_TYPES = [
  { value: 'static', label: '静止' },
  { value: 'pan', label: '平移' },
  { value: 'zoom', label: '推拉' },
  { value: 'orbit', label: '环绕' },
  { value: 'track', label: '跟踪' },
  { value: 'dolly', label: '推轨' },
];

export const SHOT_TYPES = [
  { value: 'panorama', label: '远景' },
  { value: 'full', label: '全景' },
  { value: 'medium', label: '中景' },
  { value: 'medium_close', label: '中近景' },
  { value: 'close', label: '近景' },
  { value: 'closeup', label: '特写' },
  { value: 'extreme_closeup', label: '大特写' },
];

export const LIGHTING_TYPES = [
  { value: 'natural', label: '自然光' },
  { value: 'warm', label: '暖调' },
  { value: 'cold', label: '冷调' },
  { value: 'dramatic', label: '戏剧光' },
  { value: 'silhouette', label: '剪影' },
  { value: 'soft', label: '柔光' },
  { value: 'hard', label: '硬光' },
  { value: 'neon', label: '霓虹' },
  { value: 'golden', label: '金色时刻' },
  { value: 'dim', label: '暗调' },
];
