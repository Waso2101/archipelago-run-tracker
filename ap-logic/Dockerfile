# Archipelago core (no GUI) + the game worlds we track, for logic only.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
ARG AP_VERSION=0.6.8
RUN git clone --depth 1 --branch ${AP_VERSION} https://github.com/ArchipelagoMW/Archipelago.git /ap
WORKDIR /ap
# Core requirements without the GUI toolkit.
RUN grep -viE '^(kivy|kivymd|pyshortcuts)' requirements.txt > /tmp/req.txt \
 && echo requests >> /tmp/req.txt \
 && pip install --no-cache-dir -r /tmp/req.txt
ENV SKIP_REQUIREMENTS_UPDATE=1 PYTHONUNBUFFERED=1
COPY apworlds/ /ap/custom_worlds/
COPY logic_server.py /ap/logic_server.py
RUN useradd -r -u 1001 aplogic && chown -R aplogic /ap
USER aplogic
EXPOSE 8000
CMD ["python", "/ap/logic_server.py"]
