#include "ui/MenuBar.hpp"

#include "ui/CommandIds.hpp"
#include "ui/WxConvert.hpp"

namespace life::ui {

// Accelerators always use Ctrl or a function key, so plain keys keep working in the rule text box.
// Single-key shortcuts live in WorldCanvas::onKeyDown().
wxMenuBar* buildMenuBar()
{
    auto* file = new wxMenu;
    file->Append(wxID_EXIT, "&Quit\tCtrl+Q");

    auto* automaton = new wxMenu;
    automaton->AppendRadioItem(ID_AUTOMATON_LIFE, "&Life");
    automaton->AppendRadioItem(ID_AUTOMATON_ANT, "Langton's &Ant");

    auto* engine = new wxMenu;
    engine->AppendRadioItem(ID_ENGINE_BANDED, "&Banded");
    engine->AppendRadioItem(ID_ENGINE_REFERENCE, "&Reference");

    auto* simulation = new wxMenu;
    simulation->Append(ID_RUN_PAUSE, "&Run\tF5");   // MainFrame::syncControls() switches it to "Pause"
    simulation->Append(ID_STEP, "&Step\tF6");
    simulation->AppendSeparator();
    simulation->Append(ID_FASTER, "&Faster\tCtrl+]");
    simulation->Append(ID_SLOWER, "S&lower\tCtrl+[");
    simulation->AppendCheckItem(ID_TOGGLE_MAX_SPEED, "&Max Speed\tCtrl+M");
    simulation->AppendSeparator();
    // The automaton decides whether the engine below it matters at all, so it comes first.
    simulation->AppendSubMenu(automaton, "&Automaton");
    simulation->AppendSubMenu(engine, "&Engine");

    auto* edit = new wxMenu;
    edit->Append(ID_CLEAR, "&Clear\tCtrl+Delete");
    edit->Append(ID_RANDOMIZE, "&Randomize\tCtrl+R");
    edit->Append(ID_RESET_ANTS, "Reset &Ants");   // no accelerator: every free Ctrl key is a GTK binding
    edit->AppendSeparator();
    edit->Append(ID_FOCUS_RULE, toWx("Edit R&ule…\tCtrl+L"));

    auto* world = new wxMenu;
    world->Append(ID_WORLD_SIZE, toWx("&Size…\tCtrl+N"));
    world->AppendCheckItem(ID_TOGGLE_WRAP, "&Wrap Edges\tCtrl+T");

    auto* view = new wxMenu;
    view->Append(ID_ZOOM_IN, "Zoom &In\tCtrl+=");
    view->Append(ID_ZOOM_OUT, "Zoom &Out\tCtrl+-");
    view->Append(ID_ZOOM_FIT, "&Fit World\tCtrl+0");
    view->Append(ID_CENTER_VIEW, "&Center World\tCtrl+Home");
    view->AppendSeparator();
    view->AppendCheckItem(ID_TOGGLE_GRID, "&Grid Lines\tCtrl+G");

    auto* help = new wxMenu;
    help->Append(ID_SHOW_CONTROLS_HELP, toWx("&Keyboard and Mouse…\tF1"));
    help->Append(wxID_ABOUT, "&About wxLife");

    auto* bar = new wxMenuBar;
    bar->Append(file, "&File");
    bar->Append(simulation, "&Simulation");
    bar->Append(edit, "&Edit");
    bar->Append(world, "&World");
    bar->Append(view, "&View");
    bar->Append(help, "&Help");
    return bar;
}

}
