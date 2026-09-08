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

// Inject zero-config Push Notification Listener & FCM Token Sync into entry HTML
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
    <script type="module">
      import apper from 'https://cdn.apper.io/actions/apper-actions.js';

      (function() {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications) {
          const Push = window.Capacitor.Plugins.PushNotifications;
          
          // 1. Request Push Permissions on App Launch
          Push.requestPermissions().then(function(result) {
            if (result.receive === 'granted') {
              Push.register();
            }
          });

          // 2. On FCM Registration: Store token & upload to Apper User Profile
          Push.addListener('registration', async function(token) {
            window.ApperDeviceToken = token.value;

            try {
              // Retrieve active user email or ID from Apper SDK or local storage
              const currentUser = await apper.getUser();
              if (currentUser && currentUser.email) {
                await apper.updateUser({
                  email: currentUser.email,
                  fcmToken: token.value
                });
                console.log('✅ FCM token synced with Apper user profile');
              }
            } catch (err) {
              console.warn('⚠️ Could not auto-sync FCM token to Apper:', err.message);
            }
          });

          // 3. Handle Notification Tap (Deep Linking to specific records/pages)
          Push.addListener('pushNotificationActionPerformed', function(action) {
            var data = action.notification.data;
            if (data && data.url) {
              window.location.href = data.url;
            }
            window.dispatchEvent(new CustomEvent('apperNotificationTap', { detail: data }));
          });
        }
      })();
    </script>
  `;

  if (htmlContent.includes('</head>')) {
    htmlContent = htmlContent.replace('</head>', `${pushScript}\n</head>`);
    fs.writeFileSync(htmlPath, htmlContent);
    console.log(`✅ Injected FCM token auto-sync listener into ${path.relative(process.cwd(), htmlPath)}`);
  }
}

// Configure FCM for Android using notifications/google-services.json
function configureAndroidPushNotifications() {
  const possiblePaths = [
    path.join(process.cwd(), 'notifications', 'google-services.json'),
    path.join(process.cwd(), 'google-services.json')
  ];

  const sourcePath = possiblePaths.find(p => fs.existsSync(p));

  if (!sourcePath) {
    console.log('\n💡 Tip: Place google-services.json in a "notifications/" folder at project root to auto-enable Android Push Notifications.');
    return;
  }

  const targetPath = path.join(process.cwd(), 'android', 'app', 'google-services.json');
  fs.copyFileSync(sourcePath, targetPath);
  console.log(`✅ Copied google-services.json from ${path.relative(process.cwd(), sourcePath)} to android/app/`);

  // Inject Google Services plugin into build.gradle files safely
  const rootGradlePath = path.join(process.cwd(), 'android', 'build.gradle');
  if (fs.existsSync(rootGradlePath)) {
    let content = fs.readFileSync(rootGradlePath, 'utf-8');
    if (!content.includes('com.google.gms:google-services')) {
      content = content.replace(
        /dependencies\s*\{/,
        "dependencies {\n        classpath 'com.google.gms:google-services:4.4.0'"
      );
      fs.writeFileSync(rootGradlePath, content);
      console.log('✅ Added google-services dependency to android/build.gradle');
    }
  }

  const appGradlePath = path.join(process.cwd(), 'android', 'app', 'build.gradle');
  if (fs.existsSync(appGradlePath)) {
    let content = fs.readFileSync(appGradlePath, 'utf-8');
    if (!content.includes('com.google.gms.google-services')) {
      content += "\napply plugin: 'com.google.gms.google-services'\n";
      fs.writeFileSync(appGradlePath, content);
      console.log('✅ Applied google-services plugin in android/app/build.gradle');
    }
  }
}

// Configure APNs/FCM for iOS using notifications/GoogleService-Info.plist
function configureIOSPushNotifications() {
  const possiblePaths = [
    path.join(process.cwd(), 'notifications', 'GoogleService-Info.plist'),
    path.join(process.cwd(), 'GoogleService-Info.plist')
  ];

  const sourcePath = possiblePaths.find(p => fs.existsSync(p));

  if (!sourcePath) {
    console.log('\n💡 Tip: Place GoogleService-Info.plist in a "notifications/" folder at project root to auto-enable iOS Push Notifications.');
    return;
  }

  const targetDir = path.join(process.cwd(), 'ios', 'App', 'App');
  if (fs.existsSync(targetDir)) {
    fs.copyFileSync(sourcePath, path.join(targetDir, 'GoogleService-Info.plist'));
    console.log(`✅ Copied GoogleService-Info.plist from ${path.relative(process.cwd(), sourcePath)} to ios/App/App/`);
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
      PushNotifications: {
        presentationOptions: ["badge", "sound", "alert"]
      }
    }
  };
  fs.writeFileSync('capacitor.config.json', JSON.stringify(capConfig, null, 2));
  console.log(`✅ Created capacitor.config.json with Native HTTP and Push Notifications enabled`);

  // Inject script prior to build step
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

  configureIOSPushNotifications();

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

  const targets = ['android', 'ios', 'capacitor.config.json'];
  targets.forEach(item => {
    const itemPath = path.join(process.cwd(), item);
    if (fs.existsSync(itemPath)) {
      fs.rmSync(itemPath, { recursive: true, force: true });
      console.log(`  🗑️ Removed ${item}`);
    }
  });

  const pkgPath = path.join(process.cwd(), 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    
    if (pkg.dependencies) {
      delete pkg.dependencies['@capacitor/core'];
      delete pkg.dependencies['@capacitor/push-notifications'];
    }
    if (pkg.devDependencies) {
      delete pkg.devDependencies['@capacitor/cli'];
      delete pkg.devDependencies['@capacitor/android'];
      delete pkg.devDependencies['@capacitor/ios'];
    }
    
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    console.log('  🗑️ Removed Capacitor entries from package.json');
  }

  console.log('\n✨ Reset complete! Mobile configurations have been removed.');
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

  await showMenu();
}

main();
