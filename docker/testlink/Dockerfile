# Clean, reproducible TestLink image for the AI QA pipeline.
#
# Built ourselves because the community TestLink images proved unusable:
# Bitnami's are removed from Docker Hub; icellmobilsoft hardcodes a broken
# Hungarian locale; imtnd's XML-RPC API is broken (missing ADOdb driver
# dispatcher + no API DB config). See docs/testlink-integration.md.
#
# This image: official php:7.4-apache base (TestLink 1.9.x is PHP 7.x-era;
# PHP 8 breaks it) + the required PHP extensions + TestLink 1.9.20 source
# from the official repo. The DB is a SEPARATE mysql:5.7 container
# (testlink-db); this image is the app tier only. The web installer writes
# config_db.inc.php on first run so the UI and the XML-RPC API share one DB
# config — which is exactly what the broken images got wrong.

FROM php:7.4-apache

# --- PHP extensions TestLink needs -----------------------------------------
# mysqli: DB driver (the API failure on the old image was a missing driver).
# gd: report charts. zip: import/export. mbstring/gettext: i18n.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libpng-dev libjpeg-dev libfreetype6-dev libzip-dev zlib1g-dev \
      libgmp-dev wget ca-certificates \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" mysqli gd zip gmp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# --- PHP settings TestLink expects ------------------------------------------
RUN { \
      echo 'memory_limit=256M'; \
      echo 'max_execution_time=120'; \
      echo 'session.gc_maxlifetime=4800'; \
      echo 'session.cookie_httponly=1'; \
      echo 'upload_max_filesize=20M'; \
      echo 'post_max_size=20M'; \
    } > /usr/local/etc/php/conf.d/testlink.ini

# --- Apache: allow .htaccess + set ServerName (suppresses the warning) ------
RUN a2enmod rewrite \
    && echo 'ServerName localhost' >> /etc/apache2/apache2.conf

# --- TestLink 1.9.20 source -------------------------------------------------
ARG TESTLINK_VERSION=1.9.20
RUN wget -q -O /tmp/testlink.tar.gz \
      "https://codeload.github.com/TestLinkOpenSourceTRMS/testlink-code/tar.gz/refs/tags/${TESTLINK_VERSION}" \
    && mkdir -p /var/www/html/testlink \
    && tar -xzf /tmp/testlink.tar.gz -C /var/www/html/testlink --strip-components=1 \
    && rm /tmp/testlink.tar.gz

# TestLink writes config + logs + uploads under these; make them writable.
RUN mkdir -p /var/testlink/logs /var/testlink/upload_area \
    && chown -R www-data:www-data /var/www/html/testlink /var/testlink

# The XML-RPC API must be enabled (it is by default in 1.9.20, but be explicit
# via custom_config so it survives source updates).
RUN printf "<?php\n\$tlCfg->api->enabled = TRUE;\n\$tlCfg->log_path = '/var/testlink/logs/';\n\$g_repositoryPath = '/var/testlink/upload_area/';\n" \
      > /var/www/html/testlink/custom_config.inc.php \
    && chown www-data:www-data /var/www/html/testlink/custom_config.inc.php

EXPOSE 80
