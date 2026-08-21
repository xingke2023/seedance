---
name: roll-type-field
title: 追加输出字段 roll_type
priority: 90
when: 始终 —— 系统提示词的 JSON 结构里没有这个字段，必须显式要
source: 本项目自有（前端分镜行的 A-roll / B-roll 标签依赖它）
---
## 额外输出字段
在每个镜头对象里额外增加一个字段：
  "roll_type": "a_roll" 或 "b_roll"
判定标准见上：画面中有人物正对镜头说话的是 a_roll，其余是 b_roll。
