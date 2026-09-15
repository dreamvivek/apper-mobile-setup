#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');

function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

function askQuestion(query) {
  const rl = createRL();
  return new Promise(resolve => {
    rl.question(query, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Name & ID Formatting Helpers
function formatAppName(name) {
  if (!name) return 'Mobile App';
  return name
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatAppId(name) {
  const clean = (name || 'my-app').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `com.${clean || 'example'}.app`;
}

// Auto-inject Android SDK location into local.properties
function ensureAndroidSdkLocation() {
  const androidDir = path.join(process.cwd(), 'android');
  if (!fs.existsSync(androidDir)) return;

  const localPropsPath = path.join(androidDir, 'local.properties');
  if (fs.existsSync(localPropsPath)) return;

  let sdkPath = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;

  if (!sdkPath) {
    const homeDir = os.homedir();
    if (process.platform === 'win32') {
      sdkPath = path.join(homeDir, 'AppData', 'Local', 'Android', 'Sdk');
    } else if (process.platform === 'darwin') {
      sdkPath = path.join(homeDir, 'Library', 'Android', 'sdk');
    } else {
      sdkPath = path.join(homeDir, 'Android', 'Sdk');
    }
  }

  if (fs.existsSync(sdkPath)) {
    const formattedPath = sdkPath.replace(/\\/g, '\\\\');
    fs.writeFileSync(localPropsPath, `sdk.dir=${formattedPath}\n`);
    console.log(`✅ Configured Android SDK location: ${sdkPath}`);
  } else {
    console.warn('⚠️ Android SDK directory not detected automatically. Ensure Android Studio is installed.');
  }
}

// Auto-inject required native Android permissions
function ensureAndroidPermissions() {
  const manifestPath = path.join(process.cwd(), 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) return;

  let content = fs.readFileSync(manifestPath, 'utf-8');
  const requiredPermissions = [
    '<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
    '<uses-permission android:name="android.permission.CAMERA" />',
    '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />',
    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />',
    '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />'
  ];

  let addedCount = 0;
  for (const perm of requiredPermissions) {
    if (!content.includes(perm)) {
      content = content.replace(/(<manifest[^>]*>)/i, `$1\n    ${perm}`);
      addedCount++;
    }
  }

  if (addedCount > 0) {
    fs.writeFileSync(manifestPath, content);
    console.log(`✅ Injected ${addedCount} missing permissions into AndroidManifest.xml`);
  }
}

// Remove artifacts left behind by the previous push-notification implementation
function cleanupLegacyPushArtifacts() {
  const marker = '<!-- APPER_PUSH_LISTENER_INJECTED -->';
  const htmlPaths = [
    path.join(process.cwd(), 'index.html'),
    path.join(process.cwd(), 'public', 'index.html')
  ];

  for (const htmlPath of htmlPaths) {
    if (!fs.existsSync(htmlPath)) continue;

    const content = fs.readFileSync(htmlPath, 'utf-8');
    if (!content.includes(marker)) continue;

    // Strip from the marker through the end of its <script> block, plus trailing blank lines
    const cleaned = content
      .replace(/[ \t]*<!-- APPER_PUSH_LISTENER_INJECTED -->[\s\S]*?<\/script>[ \t]*\r?\n?/, '')
      .replace(/\n{3,}/g, '\n\n');

    fs.writeFileSync(htmlPath, cleaned);
    console.log(`🧹 Removed injected push listener script from ${path.relative(process.cwd(), htmlPath)}`);
  }

  const pkgPath = path.join(process.cwd(), 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg.dependencies && pkg.dependencies['@capacitor/push-notifications']) {
      delete pkg.dependencies['@capacitor/push-notifications'];
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      console.log('🧹 Removed @capacitor/push-notifications from package.json');
    }
  }

  const capConfigPath = path.join(process.cwd(), 'capacitor.config.json');
  if (fs.existsSync(capConfigPath)) {
    try {
      const capConfig = JSON.parse(fs.readFileSync(capConfigPath, 'utf-8'));
      if (capConfig.plugins && capConfig.plugins.PushNotifications) {
        delete capConfig.plugins.PushNotifications;
        fs.writeFileSync(capConfigPath, JSON.stringify(capConfig, null, 2));
        console.log('🧹 Removed PushNotifications config from capacitor.config.json');
      }
    } catch (e) {
      console.warn('⚠️ Could not parse capacitor.config.json while cleaning up.');
    }
  }
}

// Ensure edge-to-edge inset support on projects configured by an earlier run
function ensureEdgeToEdgeSupport() {
  const pluginName = '@capawesome/capacitor-android-edge-to-edge-support';
  let installed = false;

  const pkgPath = path.join(process.cwd(), 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    pkg.dependencies = pkg.dependencies || {};
    if (!pkg.dependencies[pluginName]) {
      pkg.dependencies[pluginName] = '^8.0.8';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      installed = true;
    }
  }

  const capConfigPath = path.join(process.cwd(), 'capacitor.config.json');
  if (fs.existsSync(capConfigPath)) {
    try {
      const capConfig = JSON.parse(fs.readFileSync(capConfigPath, 'utf-8'));
      capConfig.plugins = capConfig.plugins || {};
      let changed = false;

      if (!capConfig.plugins.EdgeToEdge) {
        capConfig.plugins.EdgeToEdge = { backgroundColor: '#ffffff' };
        changed = true;
      }
      if (!capConfig.plugins.SystemBars || capConfig.plugins.SystemBars.insetsHandling !== 'disable') {
        capConfig.plugins.SystemBars = Object.assign({}, capConfig.plugins.SystemBars, { insetsHandling: 'disable' });
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(capConfigPath, JSON.stringify(capConfig, null, 2));
        console.log('✅ Enabled Edge-to-Edge status bar insets in capacitor.config.json');
      }
    } catch (e) {
      console.warn('⚠️ Could not update capacitor.config.json for edge-to-edge support.');
    }
  }

  if (installed) {
    console.log('\n📦 Installing edge-to-edge status bar support...');
    try {
      execSync('npm install', { stdio: 'inherit' });
    } catch (e) {
      console.warn('⚠️ Could not install the edge-to-edge plugin. Run "npm install" manually.');
    }
  }
}

// Generate native app icons & splash screens from assets/icon.png
function generateAppAssets(platform) {
  if (!fs.existsSync(path.join(process.cwd(), platform))) return;

  const assetsDir = path.join(process.cwd(), 'assets');
  const iconPath = path.join(assetsDir, 'icon.png');

  if (!fs.existsSync(iconPath)) {
    console.log('\n💡 Tip: Add "assets/icon.png" (1024x1024) to auto-generate your app icon.');
    return;
  }

  if (!fs.existsSync(path.join(assetsDir, 'splash.png'))) {
    console.log('💡 Tip: Add "assets/splash.png" (2732x2732) to also generate splash screens.');
  }

  console.log(`\n🎨 Generating app icons & splash screens for ${platform}...`);
  try {
    execSync(`npx @capacitor/assets generate --${platform}`, { stdio: 'inherit' });
    console.log('✅ App assets generated!');
  } catch (e) {
    console.warn('⚠️ Could not generate app assets. Verify assets/icon.png is a valid 1024x1024 PNG.');
  }
}

// Shared Core Configuration setup (without touching source code)
function prepareCapacitorConfig() {
  console.log('\n⚙️ Configuring Capacitor dependencies...');

  const pkgPath = path.join(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error('❌ Error: package.json not found in current directory!');
    return false;
  }

  cleanupLegacyPushArtifacts();

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const rawName = pkg.name || 'mobile-app';
  const appName = formatAppName(rawName);
  const appId = formatAppId(rawName);

  // 1. Dependencies
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies['@capacitor/core'] = '^8.5.1';
  // Physically insets the web view on Android 15+ edge-to-edge displays,
  // so app content never renders behind the status / navigation bars.
  pkg.dependencies['@capawesome/capacitor-android-edge-to-edge-support'] = '^8.0.8';

  pkg.devDependencies = pkg.devDependencies || {};
  pkg.devDependencies['@capacitor/cli'] = '^8.5.1';
  pkg.devDependencies['@capacitor/android'] = '^8.5.1';
  pkg.devDependencies['@capacitor/ios'] = '^8.5.1';
  pkg.devDependencies['@capacitor/assets'] = '^3.0.5';

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  console.log(`✅ Updated package.json (App Name: "${appName}", App ID: "${appId}")`);

  // 2. .gitignore updates
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  const nativeEntries = ['/android', '/ios', 'capacitor.config.json'];

  let gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  let addedEntries = [];

  for (const entry of nativeEntries) {
    if (!gitignoreContent.includes(entry)) {
      addedEntries.push(entry);
    }
  }

  if (addedEntries.length > 0) {
    gitignoreContent += `\n# Capacitor Native Output\n${addedEntries.join('\n')}\n`;
    fs.writeFileSync(gitignorePath, gitignoreContent);
    console.log(`✅ Updated .gitignore`);
  }

  // 3. Create capacitor.config.json with Native HTTP enabled
  let webDir = 'dist';
  if (fs.existsSync('build')) webDir = 'build';
  else if (fs.existsSync('out')) webDir = 'out';

  const capConfig = {
    appId: appId,
    appName: appName,
    webDir: webDir,
    ios: {
      contentInset: "always"
    },
    bundledWebRuntime: false,
    plugins: {
      CapacitorHttp: {
        enabled: true
      },
      // Status bar / navigation bar background. Change these to match your app theme.
      EdgeToEdge: {
        backgroundColor: "#ffffff"
      },
      // Required by the edge-to-edge plugin: turn off Capacitor's own CSS-variable
      // inset injection so the two do not apply the safe area twice.
      SystemBars: {
        insetsHandling: "disable"
      }
    }
  };
  fs.writeFileSync('capacitor.config.json', JSON.stringify(capConfig, null, 2));
  console.log(`✅ Created capacitor.config.json with Native HTTP and Edge-to-Edge insets enabled`);

  // 4. Install dependencies & build web package
  console.log('\n📦 Installing NPM packages...');
  try {
    execSync('npm install', { stdio: 'inherit' });
  } catch (e) {
    console.error('❌ Failed to install dependencies.');
    return false;
  }

  console.log('\n🛠️ Building production web bundle...');
  try {
    execSync('npm run build', { stdio: 'inherit' });
    console.log(`✅ Web build succeeded!`);
  } catch (e) {
    console.error('❌ Web build failed. Please resolve build errors first.');
    return false;
  }

  return true;
}

// Action: Setup Android
function setupAndroid() {
  if (!fs.existsSync('capacitor.config.json')) {
    const ok = prepareCapacitorConfig();
    if (!ok) return;
  }

  if (!fs.existsSync('android')) {
    console.log('\n🚀 Generating Android platform files...');
    try {
      execSync('npx cap add android', { stdio: 'inherit' });
    } catch (err) {
      console.error('❌ Failed to add Android platform:', err.message);
      return;
    }
  }

  ensureAndroidSdkLocation();
  ensureEdgeToEdgeSupport();
  generateAppAssets('android');

  console.log('\n🔄 Syncing web assets into Android...');
  try {
    execSync('npx cap sync android', { stdio: 'inherit' });
    ensureAndroidPermissions();
    console.log('✅ Android setup complete!');
  } catch (err) {
    console.error('❌ Sync failed:', err.message);
    return;
  }

  console.log('\n📂 Launching Android Studio...');
  try {
    execSync('npx cap open android', { stdio: 'inherit' });
  } catch (e) {
    console.error('⚠️ Could not launch Android Studio automatically.');
  }
}

// Action: Setup iOS
function setupIOS() {
  if (!fs.existsSync('capacitor.config.json')) {
    const ok = prepareCapacitorConfig();
    if (!ok) return;
  }

  if (!fs.existsSync('ios')) {
    console.log('\n🚀 Generating iOS platform files...');
    try {
      execSync('npx cap add ios', { stdio: 'inherit' });
    } catch (err) {
      console.error('❌ Failed to add iOS platform:', err.message);
      return;
    }
  }

  generateAppAssets('ios');

  console.log('\n🔄 Syncing web assets into iOS...');
  try {
    execSync('npx cap sync ios', { stdio: 'inherit' });
    console.log('✅ iOS setup complete!');
  } catch (err) {
    console.error('❌ Sync failed:', err.message);
    return;
  }

  console.log('\n📂 Launching Xcode...');
  try {
    execSync('npx cap open ios', { stdio: 'inherit' });
  } catch (e) {
    console.error('⚠️ Could not launch Xcode automatically.');
  }
}

// Action: RESET
function handleReset() {
  console.log('\n🧹 Clearing all generated mobile configurations and platforms...');

  cleanupLegacyPushArtifacts();

  const targets = ['android', 'ios', 'capacitor.config.json'];
  targets.forEach(item => {
    const itemPath = path.join(process.cwd(), item);
    if (fs.existsSync(itemPath)) {
      fs.rmSync(itemPath, { recursive: true, force: true });
      console.log(`  🗑️ Removed ${item}`);
    }
  });

  // Revert package.json dependency injections
  const pkgPath = path.join(process.cwd(), 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    if (pkg.dependencies) {
      delete pkg.dependencies['@capacitor/core'];
      delete pkg.dependencies['@capawesome/capacitor-android-edge-to-edge-support'];
      delete pkg.dependencies['@capacitor/push-notifications'];
    }
    if (pkg.devDependencies) {
      delete pkg.devDependencies['@capacitor/cli'];
      delete pkg.devDependencies['@capacitor/android'];
      delete pkg.devDependencies['@capacitor/ios'];
      delete pkg.devDependencies['@capacitor/assets'];
    }

    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    console.log('  🗑️ Removed Capacitor entries from package.json');
  }

  console.log('\n✨ Reset complete! Mobile configurations have been removed.');
  console.log('   (Your "assets/" folder was left untouched.)');
}

// Interactive CLI Loop
async function showMenu() {
  console.log(' 1) Setup Android');
  console.log(' 2) Setup iOS');
  console.log(' 3) RESET');
  console.log(' 0) Exit\n');

  const answer = await askQuestion('👉 Select an option (0-3): ');

  switch (answer) {
    case '1':
      setupAndroid();
      break;
    case '2':
      setupIOS();
      break;
    case '3':
      const confirm = await askQuestion('⚠️ Are you sure you want to delete all mobile configs & native platform folders? (y/N): ');
      if (confirm.toLowerCase() === 'y') {
        handleReset();
      } else {
        console.log('Action cancelled.');
      }
      break;
    case '0':
      console.log('\n👋 Exiting Mobile Setup Manager.\n');
      process.exit(0);
    default:
      console.log('❌ Invalid option. Please enter a number between 0 and 3.');
  }

  console.log('\n--------------------------------------------------------\n');
  await showMenu();
}

async function main() {
  console.log('\n========================================================');
  console.log('📱 Apper - Mobile Setup (https://apper.io)');
  console.log('========================================================\n');

  console.log('⚠️  REQUIRED SOFTWARE & DOWNLOAD LINKS:');
  console.log('  • Android Studio & JDK: https://developer.android.com/studio');
  console.log('  • Xcode (macOS only):   https://developer.apple.com/xcode/\n');

  console.log('🎨 APP ICON & SPLASH (optional):');
  console.log('  • assets/icon.png   (1024x1024) → app icon');
  console.log('  • assets/splash.png (2732x2732) → splash screen\n');

  await showMenu();
}

main();
