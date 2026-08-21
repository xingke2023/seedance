---
name: default-guardrails
title: 默认兜底包（画质 / 稳定 / 双胞胎）
priority: 14
when: 始终 —— 官方规范要求每条提示词都挂画质包和稳定包，多人场景再加双胞胎兜底
source: 用户提供的 Seedance 2.0 官方提示词优化器规范「强制兜底」「第三段：风格 + 约束包」
---
## 兜底包（每一镜末尾都要挂）

Seedance 对这几串兜底词反应稳定，漏掉就容易崩脸、崩肢体、冒水印。
和字幕那串否定（见 subtitle-safe-area）写在一起，放在 prompt_en 最后。

1. **画质包（必挂）**：高清，细节丰富，电影质感，色彩自然，光影柔和
   —— 英文提示词里写成 high definition, rich detail, cinematic quality,
   natural color, soft lighting
2. **稳定包（必挂）**：人物面部稳定不变形、五官清晰、动作连贯自然，不僵硬，无穿模无卡顿
   —— facial features stable and undistorted, clear facial features,
   continuous natural motion, no stiffness, no clipping, no stutter
3. **双胞胎兜底（画面里有两个及以上人物时必挂）**：
   no identical-looking people, no duplicated or cloned characters, no twin effect,
   each person keeps a distinct outfit and accessories
   —— 多人同框最常见的崩法就是模型复刻出一个同款分身
4. **强方位约束（多人正面动态镜头必挂）**：写死谁在左谁在右、各自穿什么
   （「左侧穿灰蓝色作训服的男人」），并配固定机位 —— 否则容易穿模、跳脸
5. 兜底包是**追加**，不替代具体描述 —— 光挂兜底不写清主体动作，画面照样平庸
