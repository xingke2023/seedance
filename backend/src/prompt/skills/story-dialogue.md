---
name: story-dialogue
title: 叙事短片：对白优先
when_video_type: story
priority: 20
when: video_type=story —— 第一步就要排出「有人能开口」的镜头，第二步的对白才有处可放
source: OpenMontage seedance-2-0/SKILL.md（lip-sync、多人同框）+ skills/creative/cinematic.md（镜头时长呼吸）+ skills/creative/storytelling.md（主体进出画四原语）
---
## 对白优先（本片是有人物对白的剧情片）
1. **至少三分之二的镜头要有角色在画面里说话**，这些镜头 roll_type 标 a_roll
2. 说话的镜头要看得见人：以中景/近景/特写为主，人物面部清晰、正面或侧前方，
   不要用背影、剪影或远到看不清脸的全景；prompt_en 里明确写出人物正在说话
   （talking to …, mid-conversation, speaking to camera）
3. 纯空镜（b_roll）只作过渡或情绪铺垫，不要连续出现超过 1 个
4. 场景要给对白发生的理由：两个人同处一个空间、打电话、面对镜头倾诉都可以
5. **prompt_en 里不要写具体台词内容** —— 用 talking to …, mid-conversation, speaking to camera
   表示这个人在说话就够了。台词由后续统一追加到 prompt 末尾；画面描述里再写一遍不一样的台词，
   两处打架，生成出来的人声会念错
6. **两人对话怎么排镜**：过肩镜头（OTS）先建立两人关系 → 双人中景 → 谁说话切谁的近景。
   同一镜里换说话人时用 rack focus 在两人之间来回改焦，并在 prompt_en 里写明这个交替
7. **人物进出画要写明机制**，别让模型自己猜：被揭示（镜头移动或人物入画后才看见）/
   离画（走出画或被前景遮挡）/ 焦点转移（切、改焦、甩镜从 A 换到 B）/ 一镜内焦点来回换
8. **镜头时长要呼吸**：以 4-8 秒为主，长短故意交替，同一个时长不要连着出现 3 次
9. **一个画面里最多两张脸**：多人同框是最难的一类，脸越多越容易漂。第三个人放画外音、
   给背影或让他出画 —— 这也正好和「说话的镜头要看得清脸」一致
