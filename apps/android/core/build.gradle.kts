plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "tech.jensk.synclet.core"
    compileSdk = 36
    defaultConfig {
        minSdk = 29
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.isReturnDefaultValues = true
    }
}

kotlin { jvmToolchain(21) }

// Live-Tests (Task 16) bekommen Server und Token als Gradle-Properties (-PsyncletLiveUrl=… -PsyncletLiveToken=…).
tasks.withType<Test>().configureEach {
    systemProperty("synclet.live.url", providers.gradleProperty("syncletLiveUrl").getOrElse(""))
    systemProperty("synclet.live.token", providers.gradleProperty("syncletLiveToken").getOrElse(""))
    systemProperty("synclet.live.sizeMb", providers.gradleProperty("syncletLiveSizeMb").getOrElse("48"))
}

dependencies {
    api(libs.okhttp)
    api(libs.okhttp.sse)
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.android)
    api(libs.androidx.datastore.preferences)
    api(libs.androidx.work.runtime.ktx)
    api(libs.coil.core)
    api(libs.coil.network.okhttp)
    implementation(libs.androidx.core.ktx)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.work.testing)

    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
}
