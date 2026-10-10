"""
STCB Bridge — SillyTavern x ComfyUI 桥接（ComfyUI 侧）

包含两部分：

1. 「酒馆提示词」节点（STCBPrompt）
   输出 STRING，内容由桥接在每次生成前自动写入。
   把它当成一个普通的字符串源，接到你的字符串组合节点上，
   或者直接接到 CLIPTextEncode 的 text 输入。

   位置和前后顺序完全由你在图上连出来 —— 桥接不需要猜。

2. 前端脚本（web/ 目录）
   通过 WEB_DIRECTORY 注入 ComfyUI 页面，负责：
     · 连出到桥接服务（WebSocket）
     · 收到任务后把提示词写进「酒馆提示词」节点
     · 调 api.queuePrompt() 排队，监听完成，取图回传

放在 ComfyUI/custom_nodes/ 下任意名字的文件夹里，重启 ComfyUI 即可。
"""

WEB_DIRECTORY = "./web"


class STCBPrompt:
    """
    酒馆提示词。

    内容由 SillyTavern 在每次生成前自动填入。
    框里写的东西只在「没连酒馆」时作为默认值，平时不用管。

    用法：把输出接到你的字符串组合节点，或者直接接到 CLIPTextEncode 的 text。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "tooltip": "由 SillyTavern 在生成前自动填入。这里的默认值只在没连酒馆时生效。",
                    },
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "get_prompt"
    CATEGORY = "STCB"

    def get_prompt(self, prompt):
        return (prompt or "",)


NODE_CLASS_MAPPINGS = {
    "STCBPrompt": STCBPrompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "STCBPrompt": "酒馆提示词 (SillyTavern Prompt)",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
