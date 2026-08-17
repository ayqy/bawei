# bawei 1.0.2 CWS 宣传图评审索引

## 原始候选

- `raw/promo-v1.png`：clarity-first，1573×1000，RGB。
- `raw/promo-v2.png`：proof-first，1573×1000，RGB。
- `raw/promo-v3.png`：bold-market-first，1574×999，RGB。

三张候选均由 Codex 内置 `image_gen` 各调用一次生成，没有使用 Image API、`scripts/image_gen.py` 或其他降级路径。原始候选均保留且未覆盖。

## 归一化候选

- `normalized/promo-v1-440x280.png`
- `normalized/promo-v2-440x280.png`
- `normalized/promo-v3-440x280.png`
- `normalized/promo-assets.json`：归一化尺寸、模式与源路径记录。

全部归一化候选均为 440×280 的 opaque RGB PNG，无 alpha 通道。

## 评分与采用结果

- `promo-scorecard.json`：五项评分、优缺点、淘汰原因与最高分选择。
- 采用候选：`promo-v1`，24/25。
- 商店成品：`../assets/small-promo.png`。
- 商店成品 SHA-256：`85c85646a5bf2d275b2354cb784f66ff416ec0d46f852daccc4f4d8bec3f6cdc`。

采用理由：在实际商店缩略尺寸中，八爪鱼品牌主体、单篇文章卡和多个无品牌目的地仍保持清晰；没有文字、水印、第三方 logo、伪 UI 或未经核验的发布结果。
