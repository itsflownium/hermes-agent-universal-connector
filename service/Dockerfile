FROM python:3.13-slim AS transport
COPY tools/install_iroh.py /tmp/install_iroh.py
RUN python /tmp/install_iroh.py --directory /iroh

FROM node:22-bookworm-slim
WORKDIR /app
COPY service/ ./service/
COPY --from=transport /iroh/dumbpipe /usr/local/bin/dumbpipe
ENV BIND_HOST=0.0.0.0 PORT=8787 FLOWNIUM_SERVICE_DATA=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "service/server.mjs"]
