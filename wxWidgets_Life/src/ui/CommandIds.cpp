#include "ui/CommandIds.h"

#include <wx/event.h>

namespace life::ui {

void emitCommand(wxWindow& source, CommandId id)
{
    wxCommandEvent event(wxEVT_MENU, id);
    event.SetEventObject(&source);
    source.ProcessWindowEvent(event);
}

}
