FROM debian:bookworm
LABEL original_maintainer="Paul R. Tagliamonte <paultag@sunlightfoundation.com>"

RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-dev \
    python3-pip \
    libxml2-dev \
    libxslt1-dev \
    libz-dev \
    wget \
    cron \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --upgrade pip setuptools wheel --break-system-packages

RUN mkdir -p /opt/theunitedstates.io/
WORKDIR /opt/theunitedstates.io/
RUN git clone https://github.com/unitedstates/congress.git
WORKDIR /opt/theunitedstates.io/congress/
RUN pip3 install . --break-system-packages

RUN ln -s /usr/bin/python3 /usr/bin/python

# Add the congress source tree to Python's path. Use a dynamic lookup so this
# survives Python version bumps between Debian releases.
RUN echo "/opt/theunitedstates.io/congress/" \
    > "$(python3 -c 'import site; print(site.getsitepackages()[0])')/congress.pth"

COPY ./scraper/update-legislators.sh /usr/local/bin/update-legislators.sh
RUN chmod +x /usr/local/bin/update-legislators.sh

# Place the crontab in /etc/cron.d/ — system cron reads it from there directly.
# Do NOT also run `crontab` on it; that would install a duplicate root user
# crontab and cause every job to fire twice.
COPY ./scraper/scrape_cron /etc/cron.d/scrape_cron
RUN chmod 0644 /etc/cron.d/scrape_cron

RUN mkdir -p /congress
WORKDIR /congress

CMD ["cron", "-f"]
