---
name: narration-voice-style
title: 逐镜情绪（驱动 Azure 多情感配音）
when_video_type: narration
priority: 36
when: 解说纪录片 —— 每镜的 voice_style 会转成 Azure 的 mstts:express-as，让旁白跟着情绪走
source: 本项目（Azure 神经语音的 express-as 风格）+ OpenMontage skills/meta/voice-performance-director.md（能量曲线、一段一个情绪）+ NARRATION_SYSTEM 自带的情绪弧
---
## 逐镜情绪标注

在每个镜头对象里额外增加一个字段：

  "voice_style": 五选一

| 取值 | 什么时候用 | 旁白听起来 |
|---|---|---|
| `calm` | 平铺直叙、交代背景和事实 | 平稳、有讲述感 |
| `serious` | 讲风险、讲代价、讲「不做会怎样」 | 压住、有分量 |
| `worried` | 当事人陷入困境、结果未明 | 低沉、有担忧 |
| `warm` | 问题解决、家人重聚、方案落地 | 柔和、放松 |
| `uplifting` | 结尾升华、行动感召 | 明亮、往上走 |

选取规则：

1. **跟着全片情绪弧走**，不要每镜都写 `calm`：典型是
   `calm → serious → worried → warm → uplifting`，冷起暖收
2. **一个镜头只给一种情绪** —— 一镜里既担忧又欣慰的，说明这一镜该拆成两镜
3. **相邻镜头不要在两个极端之间跳**（`worried` 直接跳 `uplifting` 会显得假），
   中间用 `calm` 或 `warm` 过一手
4. 情绪要和这一镜的画面、光线、色调一致 —— 旁白在担忧、画面却是暖阳，两边会打架
