package com.example.app

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

/**
 * Application entry point. Keep [onCreate] free of synchronous disk and network work;
 * initialize SDKs lazily or through App Startup.
 */
@HiltAndroidApp
class App : Application()
