# docker/python-runner/Dockerfile —— 工作台执行镜像（方案 §3.7、决策三）。
# 库白名单 = 镜像内容：加/换库改这里 → Actions 重新 build → 服务器 pull。
# 环境无网络（--network=none），pip install 在运行时物理上不可能——白名单无绕法。
# 容器内 uid 1000（runner）对挂载的 workspace 可写（服务器侧目录 chown 1000）。

FROM python:3.12-slim

# 基础工具只装 bash 系（slim 自带）+ 文本处理三件套；不装 curl/wget——
# 多一层"误装网络工具"的防线（禁网是硬边界，这里是纵深）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*

# 白名单库：数据分析三件套。torch/requests/scrapy 等永不进这里（决策三）。
RUN pip install --no-cache-dir numpy pandas matplotlib

# 非 root 运行用户（uid 1000 与宿主 workspace 目录的 owner 对齐）。
RUN useradd -m -u 1000 runner
USER runner
WORKDIR /workspace

# 无 ENTRYPOINT：命令由 docker run/exec 的 argv 决定（任务容器主进程是 sleep）。
