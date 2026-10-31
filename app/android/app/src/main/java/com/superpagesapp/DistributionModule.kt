package com.superpagesapp

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.uimanager.ViewManager

/**
 * Tells JS which build this is (src/distribution.ts): "sideload" (background
 * connection, in-app updater) or "play" (Google Play: neither).
 */
class DistributionModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "Distribution"

  override fun getConstants(): Map<String, Any> = mapOf("flavor" to BuildConfig.FLAVOR)
}

class DistributionPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
      listOf(DistributionModule(context))

  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
