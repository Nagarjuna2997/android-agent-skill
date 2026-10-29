package com.example.app.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import com.example.app.R
import com.example.app.ui.home.HomeRoute
import kotlinx.serialization.Serializable

/** Type-safe routes. Arguments are constructor parameters; no string templates. */
@Serializable
object Home

@Serializable
data class ItemDetail(val itemId: Long)

@Composable
fun AppNavigation(
    modifier: Modifier = Modifier,
    navController: NavHostController = rememberNavController(),
) {
    NavHost(
        navController = navController,
        startDestination = Home,
        modifier = modifier,
    ) {
        composable<Home> {
            HomeRoute(onItemClick = { item -> navController.navigate(ItemDetail(item.id)) })
        }
        composable<ItemDetail> { backStackEntry ->
            val route = backStackEntry.toRoute<ItemDetail>()
            ItemDetailPlaceholder(itemId = route.itemId)
        }
    }
}

/** Placeholder destination so the template has a second screen to navigate to. */
@Composable
private fun ItemDetailPlaceholder(itemId: Long, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = stringResource(R.string.item_detail_placeholder, itemId),
            style = MaterialTheme.typography.headlineMedium,
        )
    }
}
