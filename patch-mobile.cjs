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
    console.log(`✅ Injected missing permissions into AndroidManifest.xml`);
  }
}

// Inject zero-config Push Notification Listener into HTML
function injectPushListener() {
  const possibleHtmlPaths = [
    path.join(process.cwd(), 'index.html'),
    path.join(process.cwd(), 'public', 'index.html')
  ];

  const htmlPath = possibleHtmlPaths.find(p => fs.existsSync(p));
  if (!htmlPath) return;

  let htmlContent = fs.readFileSync(htmlPath, 'utf-8');
  const injectionMarker = '<!-- APPER_PUSH_LISTENER_INJECTED -->';

  if (htmlContent.includes(injectionMarker)) return;

  const pushScript = `
    ${injectionMarker}
    <script>
      (function() {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications) {
          const Push = window.Capacitor.Plugins.PushNotifications;
          
          // Request permissions & register on startup
          Push.requestPermissions().then(result => {
            if (result.receive === 'granted') {
              Push.register();
            }
          });

          // Handle registration token
          Push.addListener('registration', token => {
            window.ApperDeviceToken = token.value;
            window.dispatchEvent(new CustomEvent('apperDeviceTokenReady', { detail: token.value }));
          });

          // Handle tap action (Deep linking without user code change)
          Push.addListener('pushNotificationActionPerformed', action => {
            const data = action.notification.data;
            if (data && data.url) {
              window.location.href = data.url;
            }
            window.dispatchEvent(new CustomEvent('apperNotificationTap', { detail: data }));
          });
        }
      })();
    </script>
  `;

  htmlContent = htmlContent.replace('</head>', `${pushScript}\n</head>`);
  fs.writeFileSync(htmlPath, htmlContent);
  console.log(`✅ Injected zero-config push notification handler into ${path.relative(process.cwd(), htmlPath)}`);
}

// Auto-configure FCM for Android if google-services.json exists
function configureAndroidPushNotifications() {
  const rootGoogleServices = ['google-services.json', 'assets/google-services.json']
    .map(p => path.join(process.cwd(), p))
    .find(p => fs.existsSync(p));

  if (!rootGoogleServices) {
    console.log('💡 Push Notifications: No google-services.json found in root or assets/. Skipping FCM auto-config.');
    return;
  }

  const targetPath = path.join(process.cwd(), 'android', 'app', 'google-services.json');
  fs.copyFileSync(rootGoogleServices, targetPath);
  console.log('✅ Copied google-services.json to android/app/');

  // Patch root build.gradle for Google Services Plugin
  const buildGradlePath = path.join(process.cwd(), 'android', 'build.gradle');
  if (fs.existsSync(buildGradlePath)) {
    let gradleContent = fs.readFileSync(buildGradlePath, 'utf-8');
    if (!gradleContent.includes('com.google.gms:google-services')) {
      gradleContent = gradleContent.replace(
        /dependencies\s*\{/,
        "dependencies {\n        classpath 'com.google.gms:google-services:4.4.0'"
      );
      fs.writeFileSync(buildGradlePath, gradleContent);
      console.log('✅ Configured google-services classpath in android/build.gradle');
    }
  }

  // Patch app/build.gradle
  const appBuildGradlePath = path.join(process.cwd(), 'android', 'app', 'build.gradle');
  if (fs.existsSync(appBuildGradlePath)) {
    let appGradleContent = fs.readFileSync(appBuildGradlePath, 'utf-8');
    if (!appGradleContent.includes("apply plugin: 'com.google.gms.google-services'")) {
      appGradleContent += "\napply plugin: 'com.google.gms.google-services'\n";
      fs.writeFileSync(appBuildGradlePath, appGradleContent);
      console.log('✅ Applied google-services plugin in android/app/build.gradle');
    }
  }
}

// Auto-configure APNs/FCM for iOS if GoogleService-Info.plist exists
function configureIOSPushNotifications() {
  const rootPlist = ['GoogleService-Info.plist', 'assets/GoogleService-Info.plist']
    .map(p => path.join(process.cwd(), p))
    .find(p => fs.existsSync(p));

  if (!rootPlist) {
    console.log('💡 Push Notifications: No GoogleService-Info.plist found in root or assets/. Skipping iOS push auto-config.');
    return;
  }

  const targetPath = path.join(process.cwd(), 'ios', 'App', 'App', 'GoogleService-Info.plist');
  if (fs.existsSync(path.dirname(targetPath))) {
    fs.copyFileSync(rootPlist, targetPath);
    console.log('✅ Copied GoogleService-Info.plist to ios/App/App/');
  }
}

// Shared Core Configuration setup
function prepareCapacitorConfig() {
  console.log('\n⚙️ Configuring Capacitor dependencies...');

  const pkgPath = path.join(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error('❌ Error: package.json not found in current directory!');
    return false;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const rawName = pkg.name || 'mobile-app';
  const appName = formatAppName(rawName);
  const appId = formatAppId(rawName);

  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies['@capacitor/core'] = '^8.5.1';
  pkg.dependencies['@capacitor/push-notifications'] = '^8.0.0';

  pkg.devDependencies = pkg.devDependencies || {};
  pkg.devDependencies['@capacitor/cli'] = '^8.5.1';
  pkg.devDependencies['@capacitor/android'] = '^8.5.1';
  pkg.devDependencies['@capacitor/ios'] = '^8.5.1';

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  console.log(`✅ Updated package.json (App Name: "${appName}", App ID: "${appId}")`);

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

  const capConfig = {
    appId: appId,
    appName: appName,
    webDir: fs.existsSync('build') ? 'build' : fs.existsSync('out') ? 'out' : 'dist',
    ios: { contentInset: "always" },
    bundledWebRuntime: false,
    plugins: {
      CapacitorHttp: { enabled: true },
      PushNotifications: { presentationOptions: ["badge", "sound", "alert"] }
    }
  };
  fs.writeFileSync('capacitor.config.json', JSON.stringify(capConfig, null, 2));

  // Inject listener into HTML before build
  injectPushListener();

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
    console.error('❌ Web build failed.');
    return false;
  }

  return true;
}

function setupAndroid() {
  if (!fs.existsSync('capacitor.config.json')) {
    if (!prepareCapacitorConfig()) return;
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
  configureAndroidPushNotifications();
  
  console.log('\n🔄 Syncing web assets into Android...');
  try {
    execSync('npx cap sync android', { stdio: 'inherit' });
    ensureAndroidPermissions();
    console.log('✅ Android setup complete!');
  } catch (err) {
    console.error('❌ Sync failed:', err.message);
    return;
  }

  try {
    execSync('npx cap open android', { stdio: 'inherit' });
  } catch (e) {
    console.error('⚠️ Could not launch Android Studio automatically.');
  }
}

function setupIOS() {
  if (!fs.existsSync('capacitor.config.json')) {
    if (!prepareCapacitorConfig()) return;
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

  configureIOSPushNotifications();

  console.log('\n🔄 Syncing web assets into iOS...');
  try {
    execSync('npx cap sync ios', { stdio: 'inherit' });
    console.log('✅ iOS setup complete!');
  } catch (err) {
    console.error('❌ Sync failed:', err.message);
    return;
  }

  try {
    execSync('npx cap open ios', { stdio: 'inherit' });
  } catch (e) {
    console.error('⚠️ Could not launch Xcode automatically.');
  }
}

function handleReset() {
  console.log('\n🧹 Clearing all generated mobile configurations and platforms...');
  ['android', 'ios', 'capacitor.config.json'].forEach(item => {
    const itemPath = path.join(process.cwd(), item);
    if (fs.existsSync(itemPath)) {
      fs.rmSync(itemPath, { recursive: true, force: true });
    }
  });
  console.log('✨ Reset complete!');
}

async function showMenu() {
  console.log(' 1) Setup Android\n 2) Setup iOS\n 3) RESET\n 0) Exit\n');
  const answer = await askQuestion('👉 Select an option (0-3): ');

  if (answer === '1') setupAndroid();
  else if (answer === '2') setupIOS();
  else if (answer === '3') {
    const confirm = await askQuestion('⚠️ Delete configs? (y/N): ');
    if (confirm.toLowerCase() === 'y') handleReset();
  } else if (answer === '0') process.exit(0);

  await showMenu();
}

async function main() {
  console.log('\n📱 Apper - Mobile Setup Manager\n');
  await showMenu();
}

main();
