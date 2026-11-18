# Pictures of the example pages in Docker (docker-compose.yml, service shot): headless Chromium from Microsoft's
# Playwright image, driven by playwright-core of the same version. The script (page-shot.mjs) is mounted from this
# folder, nothing is installed on the host.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /opt/shot
# The library must have exactly the version of the image: it starts the browser build the image carries.
RUN npm install --no-audit --no-fund --no-save playwright-core@1.65.0 \
    && npm cache clean --force \
    && mkdir -p /out /tmp/home \
    && chmod 1777 /out /tmp/home

ENV HOME=/tmp/home \
    SHOT_OUT=/out

# The script lives in /opt/shot/tool, so its import finds /opt/shot/node_modules.
ENTRYPOINT ["node", "/opt/shot/tool/page-shot.mjs"]
