# Roteirizador OSRM com o extrato de Alagoas (seção 10 da especificação).
#
# Pipeline executado no build da imagem:
#   Geofabrik brazil/nordeste → recorte Alagoas + folga ~20 km (osmium)
#   → osrm-extract (perfil car) → osrm-contract (CH) → osrm-routed.
#
# Atualização mensal do mapa: redeployar este serviço reconstrói a imagem
# com o extrato mais recente. autoDeploy fica desligado no render.yaml para
# pushes de código não dispararem este build pesado à toa.

FROM debian:bookworm-slim AS extrato
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates osmium-tool \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /data
RUN curl -fL --retry 3 -o nordeste.osm.pbf \
  https://download.geofabrik.de/south-america/brazil/nordeste-latest.osm.pbf
# Bounding box de Alagoas com folga (minlng,minlat,maxlng,maxlat)
RUN osmium extract -b -38.45,-10.75,-35.05,-8.60 nordeste.osm.pbf -o alagoas.osm.pbf \
  && rm nordeste.osm.pbf

FROM osrm/osrm-backend:latest AS processado
COPY --from=extrato /data/alagoas.osm.pbf /data/
RUN osrm-extract -p /opt/car.lua /data/alagoas.osm.pbf \
  && osrm-contract /data/alagoas.osrm \
  && rm /data/alagoas.osm.pbf

FROM osrm/osrm-backend:latest
COPY --from=processado /data /data
# O Render injeta PORT; localmente cai em 5000.
CMD osrm-routed --algorithm ch --max-trip-size 200 --max-table-size 8000 \
  --ip 0.0.0.0 --port ${PORT:-5000} /data/alagoas.osrm
