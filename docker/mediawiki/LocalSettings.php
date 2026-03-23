<?php
/**
 * CaveWiki LocalSettings.php — all values from environment variables.
 */

# Protect against web access
if ( !defined( 'MEDIAWIKI' ) ) {
    exit;
}

## Database settings — SQLite on EBS volume
$wgDBtype         = 'sqlite';
$wgDBname         = 'cavewiki';
$wgSQLiteDataDir  = '/var/www/html/data';

## Site configuration
$wgServer     = getenv( 'MW_SERVER' );
$wgSitename   = getenv( 'MW_SITENAME' ) ?: 'CaveWiki';
$wgScriptPath = '';

## Security keys
$wgSecretKey  = getenv( 'MW_SECRET_KEY' );
$wgUpgradeKey = getenv( 'MW_UPGRADE_KEY' );

## Password policy
$wgPasswordPolicy['policies']['default']['MinimalPasswordLength'] = 8;

## Private wiki — no anonymous access
$wgGroupPermissions['*']['read']          = false;
$wgGroupPermissions['*']['edit']          = false;
$wgGroupPermissions['*']['createaccount'] = false;

## File uploads (EFS mount point)
$wgEnableUploads  = true;
$wgUploadPath     = "$wgScriptPath/images";
$wgUploadDirectory = '/var/www/html/images';

## Skin
wfLoadSkin( 'Vector' );

## Semantic MediaWiki
wfLoadExtension( 'SemanticMediaWiki' );
enableSemantics( getenv( 'MW_SITENAME' ) ?: 'CaveWiki' );
