# bawei CWS 1.0.3 视觉研究记录

检查日期：2026-08-17

## 来源

1. https://developer.chrome.com/docs/webstore/images/
   - source_type：官方平台约束
   - what_it_shows：小型宣传图必须为 440×280；宣传图应主要传达品牌，不能只拿截图代替；截图接受 1280×800 或 640×400。
   - useful_pattern：小尺寸下使用单一主体、简单轮廓和品牌一致配色。
   - risk_if_copied_blindly：把真实产品截图直接缩成宣传图会使 UI 与文字无法辨认。
   - where_to_apply：最终尺寸、无 alpha 验收、主体占比和避免细字。

2. https://developer.chrome.com/docs/webstore/best-listing/
   - source_type：官方高质量商店页指南
   - what_it_shows：商店素材应准确、清楚地表达扩展能力；截图需对应最新功能，品牌元素保持一致。
   - useful_pattern：以产品的唯一用途组织一张图，只显示可由当前版本证明的动作。
   - risk_if_copied_blindly：为了“丰富”加入虚构界面或第三方 logo 会降低准确性并增加政策风险。
   - where_to_apply：八爪鱼品牌主体、文章卡片与无品牌目的地节点。

3. https://chromewebstore.google.com/
   - source_type：当前商店展示画廊
   - what_it_shows：发现页卡片在小尺寸中依赖强轮廓、有限配色和单一视觉焦点。
   - useful_pattern：缩略图先读主体，再读动作；避免依赖细小文字说明。
   - risk_if_copied_blindly：照搬其他扩展的具体图形或品牌会丢失 bawei 的产品识别。
   - where_to_apply：三套候选均保持一个主焦点和高对比背景。

4. https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide#2-prompting-fundamentals
   - source_type：当前官方提示词结构参考
   - what_it_shows：按背景/场景、主体、关键细节、约束组织提示词；明确用途、构图、放置关系和禁止项。
   - useful_pattern：为每个候选固定产品含义，只改变构图风格；明确 no text、no watermark、no third-party logos、no fake UI。
   - risk_if_copied_blindly：堆叠过多质量词会削弱构图约束。
   - where_to_apply：`promo-prompts.md` 的三套结构化提示词。

## 三类可复用风格

- clarity-first：扁平品牌插画、单一主体、强轮廓；最适合小型宣传图。
- proof-first：可读的单向内容流；适合表达严格串行，但必须避免伪 UI。
- bold-market-first：更大主体与放射动势；辨识度高，但要控制节点密度。

三者都固定为“现有八爪鱼品牌 + 一张文章卡片 + 多个无品牌目的地”，只改变构图和动势，不改变产品事实。
