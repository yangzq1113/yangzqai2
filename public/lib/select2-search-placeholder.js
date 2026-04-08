(function($) {

    var isMobileUA = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    var unlockedByField = new WeakMap();
    var unlockHandlerByField = new WeakMap();

    function unlockSearchField(searchField) {
        if (!(searchField instanceof HTMLInputElement || searchField instanceof HTMLTextAreaElement)) {
            return;
        }

        if (unlockHandlerByField.has(searchField)) {
            searchField.removeEventListener('pointerdown', unlockHandlerByField.get(searchField));
            searchField.removeEventListener('touchstart', unlockHandlerByField.get(searchField));
            searchField.removeEventListener('mousedown', unlockHandlerByField.get(searchField));
            unlockHandlerByField.delete(searchField);
        }

        searchField.readOnly = false;
        unlockedByField.set(searchField, true);
    }

    var Defaults = $.fn.select2.amd.require('select2/defaults');

    $.extend(Defaults.defaults, {
        searchInputPlaceholder: '',
        searchInputCssClass: '',
    });

    var SearchDropdown = $.fn.select2.amd.require('select2/dropdown/search');

    var _renderSearchDropdown = SearchDropdown.prototype.render;

    SearchDropdown.prototype.render = function(decorated) {

        // invoke parent method
        var $rendered = _renderSearchDropdown.apply(this, Array.prototype.slice.apply(arguments));

        this.$search.attr('placeholder', this.options.get('searchInputPlaceholder'));
        this.$search.addClass(this.options.get('searchInputCssClass'));

        return $rendered;
    };

    // Mobile: prevent virtual keyboard from auto-popping when select2 opens.
    // Keep the search input readOnly until the user explicitly taps it.
    $(document).on('select2:open', function () {
        if (!isMobileUA) return;
        var searchField = document.querySelector('.select2-container--open .select2-search__field');
        if (!(searchField instanceof HTMLInputElement || searchField instanceof HTMLTextAreaElement)) return;

        if (unlockedByField.get(searchField) === true) {
            return;
        }

        searchField.readOnly = true;

        if (document.activeElement === searchField) {
            searchField.blur();
        }

        var unlockOnPointer = function () {
            unlockSearchField(searchField);
            // Re-focus after unlocking so manual tap still allows typing immediately.
            setTimeout(function () { searchField.focus(); }, 0);
        };

        unlockHandlerByField.set(searchField, unlockOnPointer);
        searchField.addEventListener('pointerdown', unlockOnPointer, { once: true });
        searchField.addEventListener('touchstart', unlockOnPointer, { once: true });
        searchField.addEventListener('mousedown', unlockOnPointer, { once: true });
    });

    $(document).on('select2:close', function () {
        if (!isMobileUA) return;
        unlockedByField = new WeakMap();
        unlockHandlerByField = new WeakMap();
    });

})(window.jQuery);
