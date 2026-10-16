package tech.jensk.synclet.ui

import androidx.annotation.StringRes
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.window.core.layout.WindowSizeClass
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R

private enum class Tab(val route: Any, @StringRes val label: Int, val icon: ImageVector, val tag: String) {
    FILES(FilesRoute, R.string.nav_files, Icons.Outlined.Folder, TestTags.NAV_FILES),
    RECENT(RecentRoute, R.string.nav_recent, Icons.Outlined.History, TestTags.NAV_RECENT),
    SEARCH(SearchRoute(), R.string.nav_search, Icons.Outlined.Search, TestTags.NAV_SEARCH),
    TRASH(TrashRoute, R.string.nav_trash, Icons.Outlined.Delete, TestTags.MORE_TRASH),
    UPLOADS(UploadsRoute, R.string.nav_uploads, Icons.Outlined.CloudUpload, TestTags.MORE_UPLOADS),
    MORE(MoreRoute, R.string.nav_more, Icons.Outlined.MoreHoriz, TestTags.NAV_MORE),
}

@Composable
fun AppScaffold(graph: AppGraph) {
    val nav = rememberNavController()
    val wide = currentWindowAdaptiveInfo().windowSizeClass.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND)
    // Phone: Files, Recent, Search, More (Trash/Uploads inside More). Tablet: rail with Trash and Uploads as well.
    val tabs = if (wide) Tab.entries else listOf(Tab.FILES, Tab.RECENT, Tab.SEARCH, Tab.MORE)
    val entry by nav.currentBackStackEntryAsState()
    NavigationSuiteScaffold(navigationSuiteItems = {
        tabs.forEach { tab ->
            item(
                selected = entry?.destination?.hierarchy?.any { it.hasRoute(tab.route::class) } == true,
                onClick = {
                    nav.navigate(tab.route) {
                        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                },
                icon = { Icon(tab.icon, contentDescription = null) },
                label = { Text(stringResource(tab.label)) },
                modifier = Modifier.testTag(tab.tag),
            )
        }
    }) {
        AppNavHost(graph, nav)
    }
}
