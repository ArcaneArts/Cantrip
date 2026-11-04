FROM rust:1.95.0-trixie@sha256:f49565f188ee00bc2a18dd418183f2c5f23ef7d6e691890517ed341a598f67c3 AS compiler
ARG TARGETARCH
WORKDIR /source
COPY cantrip_cua/ cantrip_cua/
COPY cantrip_interaction/ cantrip_interaction/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cantrip-os-cua-${TARGETARCH},target=/target,sharing=locked \
    cargo build --locked --release --manifest-path cantrip_cua/Cargo.toml --target-dir /target \
    && mkdir -p /runtime/licenses \
    && cp /target/release/cantrip-cua /runtime/cantrip-cua \
    && find cantrip_cua/src cantrip_interaction/src -type f -print0 | sort -z | xargs -0 sha256sum > /runtime/build-manifest.sha256 \
    && sha256sum cantrip_cua/Cargo.toml cantrip_cua/Cargo.lock cantrip_interaction/Cargo.toml /runtime/cantrip-cua >> /runtime/build-manifest.sha256 \
    && find /usr/local/cargo/registry/src -type f \( -iname 'license*' -o -iname 'copying*' \) -exec cp --parents '{}' /runtime/licenses/ \;

FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS package
COPY --from=compiler /runtime/ /runtime/
COPY cantrip_os/packages/remote/ /package/
RUN /package/build.sh /runtime /out

FROM scratch AS deb
COPY --from=package /out/ /
