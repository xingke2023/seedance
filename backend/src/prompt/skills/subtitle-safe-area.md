---
name: subtitle-safe-area
title: 字幕留位与画面内文字
priority: 12
when: 始终 —— 成片会把字幕烧进画面下三分之一，模型自己再渲一层就会重叠
source: 本项目（合并链路固定烧下方字幕；「别在提示词里提 subtitles」是踩坑后加的）+ OpenMontage seedance-2-0/SKILL.md（画面内文字渲不准）
---
## 字幕留位与画面内文字

字幕是**后期用 ffmpeg 烧进去的**，Seedance 生成的画面里一个字都不该有 ——
模型自己渲一层字幕，就会和烧录的那层重叠。

1. **下三分之一保持干净**：人脸、主体动作、关键道具都不要压在画面底部。
   prompt_en 里固定写成 lower third of frame kept clean and unobstructed，
   **不要写成 upper third**（字幕烧在底部）
2. ⚠️ **prompt_en 里不许出现 subtitle / caption / text overlay 这类词来解释留位原因** ——
   提到它，模型就会真的在画面里渲一行字。留位只说「保持干净」，不说留给谁
3. **每一镜的否定串里都要带上**（和 no cuts / no zoom 写在一起）：
   no subtitles, no captions, no on-screen text, no watermark, no logo
4. **画面里不要出现需要看清的文字或 logo**：文字渲染不可靠，会糊成乱码。
   要出现文件、合同、报告，就让文字不可辨（浅景深虚化、只拍纸张边缘和签字动作）
5. **对白不会自动变成画面上的字**：台词块是给口型和人声用的，
   写台词不等于要把台词显示出来 —— 见第 3 条那串否定