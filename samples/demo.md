---
title: smart-publisher 验证样例
tags: [markdown, 发布, 测试]
---

# smart-publisher 验证样例

这是一段正文，用来验证 **加粗**、*斜体*、`行内代码`、[链接](https://example.com) 与行内公式 $E = mc^2$。

## 1. 代码高亮

```python
def publish(markdown: str, platform: str) -> None:
    """把 Markdown 发到指定平台"""
    html = render(markdown)
    return send(html, platform)
```

## 2. 块级公式

$$
L(\theta) = -\frac{1}{N}\sum_{i=1}^{N}\Big[\, y_i\log \hat{y}_i + (1-y_i)\log(1-\hat{y}_i) \,\Big]
$$

行内也可混排：当 $x \to 0$ 时 $\sin x \approx x$。

## 3. 表格

| 平台 | 公式 | 图片 | 代码高亮 |
| :--- | :--: | :--: | :------: |
| 微信公众号 | ✅ | ✅ | ✅ |
| 知乎 | ✅ | ✅ | ✅ |
| 小红书 | ✅ | ✅ | ✅ |

## 4. 引用与列表

> 验证一直做，发布不翻车。

- 一级要点
  - 二级要点
- [x] 已完成的任务
- [ ] 未完成的任务

## 5. 图片

![示例图片](https://picsum.photos/seed/smart-publisher/600/300)

---

*样例结束 —— 右侧面板里挨个点一遍就知道各个功能对不对。*
