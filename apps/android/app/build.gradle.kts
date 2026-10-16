import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.play.publisher)
}

// Signierdaten aus keystore.properties (git-ignoriert) oder Umgebungsvariablen – nie im Repo.
val keystoreProperties = Properties().apply {
    rootProject.file("keystore.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
fun signingValue(key: String, env: String): String? = System.getenv(env) ?: keystoreProperties.getProperty(key)
val releaseStoreFile = signingValue("storeFile", "SYNCLET_KEYSTORE_FILE")?.let { rootProject.file(it) }
val hasReleaseSigning = releaseStoreFile?.exists() == true
// Service-Account-JSON der Play Developer API: Pfad außerhalb des Repos.
val playCredentials = (System.getenv("SYNCLET_PLAY_CREDENTIALS") ?: keystoreProperties.getProperty("playCredentials"))?.let { rootProject.file(it) }

// Release-Builds setzen beides über build_release.sh (Task 10).
val syncletVersionName = providers.gradleProperty("syncletVersionName").getOrElse("0.1.5-dev")
val syncletVersionCode = providers.gradleProperty("syncletVersionCode").map { it.toInt() }.getOrElse(1)

android {
    namespace = "tech.jensk.synclet"
    compileSdk = 36
    defaultConfig {
        applicationId = "tech.jensk.synclet"
        minSdk = 29
        targetSdk = 36
        versionCode = syncletVersionCode
        versionName = syncletVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = releaseStoreFile
                storePassword = signingValue("storePassword", "SYNCLET_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "SYNCLET_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "SYNCLET_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
    packaging {
        resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    }
}

kotlin { jvmToolchain(21) }

dependencies {
    implementation(project(":core"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material3.navigation.suite)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.compose.material3.adaptive.layout)
    implementation(libs.androidx.compose.material3.adaptive.navigation)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.ui)
    implementation(libs.coil.compose.core)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.work.testing)

    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.uiautomator)
    androidTestImplementation(libs.okhttp.mockwebserver)

    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}

// ./gradlew :app:publishReleaseBundle → interner Testkanal. Die allererste AAB muss von Hand in die Play Console.
play {
    enabled.set(playCredentials?.exists() == true)
    playCredentials?.takeIf { it.exists() }?.let { serviceAccountCredentials.set(it) }
    track.set("internal")
    defaultToAppBundles.set(true)
}
