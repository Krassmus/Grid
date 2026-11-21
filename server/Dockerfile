# Grid-Server als Container (Firmennetz). Bauen: docker build -t grid-server server
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home /data --shell /usr/sbin/nologin grid \
    && mkdir -p /data && chown grid:grid /data
COPY --from=build /src/target/release/grid-server /usr/local/bin/grid-server
USER grid
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["grid-server"]
CMD ["--listen", "0.0.0.0:8787", "--data", "/data"]
