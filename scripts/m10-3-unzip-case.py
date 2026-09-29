"""M10.3 真实案例 ZIP 解压助手（GBK 条目名修复）。

用法：python m10-3-unzip-case.py <zip> <dest>
ZIP 内中文文件名按 GBK 编码存储（未设 UTF-8 flag）——标准 zipfile 按 cp437
解码会得到乱码，导致 paper.tex 的 \includegraphics{figs/UA-DETRAC跟踪结果.pdf}
无法命中。本脚本对未设 UTF-8 flag 的条目做 cp437 → GBK 重解码。
"""

import sys
import zipfile
from pathlib import Path


def main() -> None:
    zip_path, dest = sys.argv[1], sys.argv[2]
    root = Path(dest)
    root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            name = info.filename
            if not (info.flag_bits & 0x800):
                try:
                    name = name.encode("cp437").decode("gbk")
                except (UnicodeDecodeError, UnicodeEncodeError):
                    pass
            target = root / name
            if info.is_dir() or name.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, open(target, "wb") as sink:
                sink.write(source.read())
    print(f"extracted to {dest}")


if __name__ == "__main__":
    main()
