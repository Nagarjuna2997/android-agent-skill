package com.example.app

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.example.app.data.Item
import com.example.app.ui.home.HomeEvent
import com.example.app.ui.home.HomeScreen
import com.example.app.ui.home.HomeUiState
import com.example.app.ui.theme.AppTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Tests the stateless [HomeScreen] with hand-built states. No ViewModel, no Hilt:
 * what is asserted is rendering and event wiring. A Hilt-backed end-to-end test
 * would use createAndroidComposeRule<MainActivity>() with @HiltAndroidTest.
 */
@RunWith(AndroidJUnit4::class)
class HomeScreenTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun loadingState_showsProgressIndicator() {
        composeRule.setContent {
            AppTheme { HomeScreen(HomeUiState.Loading, onEvent = {}, onItemClick = {}) }
        }

        composeRule.onNodeWithTag("home_loading").assertIsDisplayed()
    }

    @Test
    fun emptyState_showsEmptyMessage() {
        composeRule.setContent {
            AppTheme { HomeScreen(HomeUiState.Empty, onEvent = {}, onItemClick = {}) }
        }

        composeRule.onNodeWithTag("home_empty").assertIsDisplayed()
    }

    @Test
    fun contentState_showsItems_andClickReportsItem() {
        val items = listOf(Item(1, "Alpha"), Item(2, "Beta"))
        var clicked: Item? = null

        composeRule.setContent {
            AppTheme { HomeScreen(HomeUiState.Content(items), onEvent = {}, onItemClick = { clicked = it }) }
        }

        composeRule.onNodeWithText("Alpha").assertIsDisplayed()
        composeRule.onNodeWithText("Beta").assertIsDisplayed().performClick()
        assertEquals(Item(2, "Beta"), clicked)
    }

    @Test
    fun addButton_isDisabledUntilTextEntered_andSendsAddEvent() {
        val events = mutableListOf<HomeEvent>()

        composeRule.setContent {
            AppTheme { HomeScreen(HomeUiState.Empty, onEvent = { events += it }, onItemClick = {}) }
        }

        composeRule.onNodeWithTag("home_add_button").assertIsNotEnabled()
        composeRule.onNodeWithTag("home_new_item_field").performTextInput("Gamma")
        composeRule.onNodeWithTag("home_add_button").assertIsEnabled().performClick()

        assertEquals(listOf<HomeEvent>(HomeEvent.AddItem("Gamma")), events)
    }

    @Test
    fun errorState_showsMessage_andRetrySendsRefresh() {
        val events = mutableListOf<HomeEvent>()

        composeRule.setContent {
            AppTheme { HomeScreen(HomeUiState.Error("Could not load"), onEvent = { events += it }, onItemClick = {}) }
        }

        composeRule.onNodeWithTag("home_error").assertIsDisplayed()
        composeRule.onNodeWithText("Retry").performClick()
        assertEquals(listOf<HomeEvent>(HomeEvent.Refresh), events)
    }
}
