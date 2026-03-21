<?php
/**
 * CaveWiki LocalSettings.php — all values from environment variables.
 */

# Protect against web access
if ( !defined( 'MEDIAWIKI' ) ) {
    exit;
}

## Database settings
$wgDBtype     = 'mysql';
$wgDBserver   = getenv( 'MW_DB_HOST' );
$wgDBname     = getenv( 'MW_DB_NAME' ) ?: 'cavewiki';
$wgDBuser     = 'admin';
$wgDBpassword = getenv( 'MW_DB_PASSWORD' );

# Aurora Serverless v2 scale-to-zero compatibility (25-30s cold start resume)
$wgDBservers = [
    [
        'host'           => $wgDBserver,
        'dbname'         => $wgDBname,
        'user'           => $wgDBuser,
        'password'       => $wgDBpassword,
        'type'           => $wgDBtype,
        'flags'          => DBO_DEFAULT,
        'load'           => 1,
        'connectTimeout' => 60,
    ],
];

## Site configuration
$wgServer     = getenv( 'MW_SERVER' );
$wgSitename   = getenv( 'MW_SITENAME' ) ?: 'CaveWiki';
$wgScriptPath = '';

## Security keys
$wgSecretKey  = getenv( 'MW_SECRET_KEY' );
$wgUpgradeKey = getenv( 'MW_UPGRADE_KEY' );

## Private wiki — no anonymous access
$wgGroupPermissions['*']['read']          = false;
$wgGroupPermissions['*']['edit']          = false;
$wgGroupPermissions['*']['createaccount'] = false;

## File uploads (EFS mount point)
$wgEnableUploads  = true;
$wgUploadPath     = "$wgScriptPath/images";
$wgUploadDirectory = '/var/www/html/images';

## Semantic MediaWiki
wfLoadExtension( 'SemanticMediaWiki' );
enableSemantics( getenv( 'MW_SITENAME' ) ?: 'CaveWiki' );
