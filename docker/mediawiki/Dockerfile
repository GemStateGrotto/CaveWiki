FROM mediawiki:1.45

# SQLite support (MediaWiki uses PDO) + curl for health checks + composer deps
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl unzip libsqlite3-dev \
    && docker-php-ext-install pdo_sqlite \
    && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

# Install Semantic MediaWiki via Composer
COPY composer.local.json /var/www/html/composer.local.json
RUN COMPOSER_ROOT_VERSION=1.45.0 composer config --global audit.block-insecure false \
    && COMPOSER_ROOT_VERSION=1.45.0 composer update --no-dev --working-dir=/var/www/html

# Copy configuration files
COPY LocalSettings.php /var/www/html/LocalSettings.php
COPY origin-verify.conf /etc/apache2/conf-enabled/origin-verify.conf
COPY jobrunner.sh /usr/local/bin/jobrunner.sh
RUN chmod +x /usr/local/bin/jobrunner.sh
