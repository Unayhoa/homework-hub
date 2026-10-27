plugins {
    id("com.android.application")
}

android {
    namespace = "cn.homeworkhub.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "cn.homeworkhub.app"
        minSdk = 26          // adaptive icon / WebViewAssetLoader 都要求 26+
        targetSdk = 34
        versionCode = 108
        versionName = "0.2.7"
    }

    buildTypes {
        release {
            // 测试阶段不混淆：出现问题时的堆栈才看得懂
            isMinifyEnabled = false
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // 前端资源由 npm run android:sync 生成到 assets/www
    // 这里不声明 sourceset，用默认的 src/main/assets 即可
    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

dependencies {
    // 唯一依赖：WebViewAssetLoader（把 assets 以 https 域提供给 WebView，
    // 这是 ES Module 能加载的前提 —— file:// 下模块会被 CORS 拦掉）
    implementation("androidx.webkit:webkit:1.11.0")
}
