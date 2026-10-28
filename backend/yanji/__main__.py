"""python -m yanji：只启动Python后端，Node仅用于构建React前端。"""

import os
import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "yanji.app:create_app",
        factory=True,
        host="127.0.0.1",
        port=int(os.getenv("PORT", "4320")),
        reload=os.getenv("YANJI_RELOAD") == "1",
        reload_dirs=["backend"] if os.getenv("YANJI_RELOAD") == "1" else None,
    )
