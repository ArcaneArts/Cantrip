FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS package
COPY cantrip_os/packages/recovery/ /package/
COPY cantrip_os/host/package-job.py /runtime/package-job.py
ENV CANTRIP_OS_PACKAGE_JOB_SOURCE=/runtime/package-job.py
RUN /package/build.sh /out
FROM scratch
COPY --from=package /out/ /
