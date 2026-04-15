FROM debian:bullseye
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


RUN pip3 install --upgrade pip setuptools wheel

RUN mkdir -p /opt/theunitedstates.io/
WORKDIR /opt/theunitedstates.io/
RUN git clone https://github.com/unitedstates/congress.git
WORKDIR /opt/theunitedstates.io/congress/
RUN pip3 install .

RUN ln -s /usr/bin/python3 /usr/bin/python

RUN echo "/opt/theunitedstates.io/congress/" > /usr/local/lib/python3.9/dist-packages/congress.pth

COPY ./scraper/update-legislators.sh /usr/local/bin/update-legislators.sh
RUN chmod +x /usr/local/bin/update-legislators.sh

COPY ./scraper/scrape_cron /etc/cron.d/scrape_cron
RUN chmod 0644 /etc/cron.d/scrape_cron && crontab /etc/cron.d/scrape_cron

RUN mkdir -p /congress
WORKDIR /congress

# CMD ["usc-run", "votes"]
CMD ["cron", "-f"]