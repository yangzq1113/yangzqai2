(function($) {

    var isMobileUA = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    var SELECT2_USER_FOCUS_GRACE_MS = 900;
    var lastSelect2SearchUserIntentTs = 0;

    function isSelect2SearchField(target) {
        return target instanceof HTMLInputElement && target.classList.contains('select2-search__field')
            || target instanceof HTMLTextAreaElement && target.classList.contains('select2-search__field');
    }

    function markSelect2UserIntent(event) {
        if (!isMobileUA) return;
        if (!(event.target instanceof Element)) {
            return;
        }

        if (event.target.closest('.select2-container--open .select2-search__field')) {
            lastSelect2SearchUserIntentTs = Date.now();
        }
    }

    function guardProgrammaticSelect2Focus(event) {
        if (!isMobileUA) return;

        var target = event.target;
        if (!isSelect2SearchField(target)) {
            return;
        }

        var elapsed = Date.now() - lastSelect2SearchUserIntentTs;
        if (elapsed <= SELECT2_USER_FOCUS_GRACE_MS) {
            target.readOnly = false;
            return;
        }

        target.readOnly = true;
        target.blur();
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
    // Keep the search input readOnly and only unlock it on explicit user tap.
    $(document).on('select2:open', function () {
        if (!isMobileUA) return;
        var searchField = document.querySelector('.select2-container--open .select2-search__field');
        if (!(searchField instanceof HTMLInputElement || searchField instanceof HTMLTextAreaElement)) return;

        searchField.readOnly = true;

        if (document.activeElement === searchField) {
            searchField.blur();
        }
    });

    document.addEventListener('pointerdown', markSelect2UserIntent, true);
    document.addEventListener('touchstart', markSelect2UserIntent, true);
    document.addEventListener('mousedown', markSelect2UserIntent, true);
    document.addEventListener('focusin', guardProgrammaticSelect2Focus, true);

})(window.jQuery);
